import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AuditRow,
  PricingManifest,
  PricingSnapshot,
  type CacheDuration,
  type FrozenSnapshot,
  type NormalizedUsageRow,
} from '../../src/engine/contracts'
import { formatUsd, usdToFemto } from '../../src/engine/money'
import { contextThresholds, createPricingEngine, priceLabel, providerFamily, rateKey } from '../../src/engine/pricing'
import { ALIASES, resolveModel } from '../../src/engine/resolve'

const ROOT = join(__dirname, '..', '..')
const worked = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'worked-examples.json'), 'utf8')) as {
  snapshot: { file: string; date: string; sha256: string; commit: string }
  examples: {
    name: string
    modelKey: string
    tokens: NormalizedUsageRow['tokens']
    tierStated: NormalizedUsageRow['tierStated']
    expectedUsd: string
    expectedDisplay: string
    formula: string
    neverUsd?: string
  }[]
}
const snapshotBytes = readFileSync(join(ROOT, 'public', 'pricing', worked.snapshot.file))
const snapshot = PricingSnapshot.parse(JSON.parse(snapshotBytes.toString('utf8')))
const meta: FrozenSnapshot = { file: worked.snapshot.file, date: worked.snapshot.date, sha256: worked.snapshot.sha256, commit: worked.snapshot.commit }
const engine = createPricingEngine(snapshot, meta)

function writes(w: Partial<Record<CacheDuration, number>> = {}): NormalizedUsageRow['tokens']['cacheWrite'] {
  return { '5m': 0, '1h': 0, '30m': 0, '12h': 0, ...w }
}

function row(over: Omit<Partial<NormalizedUsageRow>, 'tokens'> & { tokens?: Partial<NormalizedUsageRow['tokens']> } = {}): NormalizedUsageRow {
  const { tokens, ...rest } = over
  return {
    rowIndex: 0,
    timestamp: '2026-10-01T00:00:00.000Z',
    variant: 'A-json',
    provider: 'openai',
    modelLogged: 'gpt-4o',
    tierStated: 'standard',
    granularity: 'request',
    notMeasured: [],
    excluded: {},
    reported: null,
    raw: {},
    mapping: [],
    flags: [],
    unresolvedReason: null,
    counted: true,
    requests: 1,
    ...rest,
    tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: writes(), output: 0, reasoning: null, ...tokens },
  }
}

function price(r: NormalizedUsageRow) {
  const out = engine.price(r)
  AuditRow.parse(out)
  return out
}

describe('snapshot pinning', () => {
  it('the stored snapshot matches the recorded SHA-256 and the manifest', () => {
    const sha = createHash('sha256').update(snapshotBytes).digest('hex')
    expect(sha).toBe(worked.snapshot.sha256)
    expect(worked.snapshot.file.startsWith(`${worked.snapshot.date}-${sha.slice(0, 8)}`)).toBe(true)
    const manifest = PricingManifest.parse(JSON.parse(readFileSync(join(ROOT, 'public', 'pricing', 'manifest.json'), 'utf8')))
    const entry = manifest.snapshots.find((s) => s.file === worked.snapshot.file)
    expect(entry?.sha256).toBe(sha)
    expect(snapshot.source.commit).toBe(worked.snapshot.commit)
  })

  it('every worked example model key exists exactly', () => {
    for (const ex of worked.examples) expect(snapshot.models[ex.modelKey]).toBeDefined()
  })
})

describe('worked examples', () => {
  for (const ex of worked.examples) {
    it(`${ex.modelKey}: ${ex.name} costs exactly ${ex.expectedUsd}`, () => {
      const out = price(row({ modelLogged: ex.modelKey, tierStated: ex.tierStated, tokens: ex.tokens }))
      expect(out.cost.valueUsd).toBe(ex.expectedUsd)
      expect(out.cost.estimateUsd).toBe(ex.expectedUsd)
      expect(out.cost.label.kind).toBe('Estimated')
      expect(out.cost.formula).toBe(ex.formula)
      expect(formatUsd(usdToFemto(out.cost.valueUsd!))).toBe(ex.expectedDisplay)
      expect(out.match.kind).toBe('exact')
      expect(out.resolvedKey).toBe(ex.modelKey)
      if (ex.neverUsd) {
        expect(out.cost.valueUsd).not.toBe(ex.neverUsd)
        expect(out.cost.estimateUsd).not.toBe(ex.neverUsd)
      }
      const sum = out.cost.appliedRates.reduce((s, a) => s + usdToFemto(a.costUsd), 0n)
      expect(sum).toBe(usdToFemto(ex.expectedUsd))
    })
  }

  it('gpt-4o: counting cached tokens as uncached would give 0.010415, which is never produced', () => {
    const out = price(row({ tokens: { uncachedInput: 86, cacheRead: 1920, output: 300 } }))
    expect(out.cost.valueUsd).toBe('0.005615')
    expect(out.cost.valueUsd).not.toBe('0.010415')
  })

  it('gpt-6.1-sol: uncached is 1000 after writes are subtracted, so 0.0489 is never produced', () => {
    const out = price(row({ modelLogged: 'gpt-6.1-sol', variant: 'B-json', tokens: { uncachedInput: 1000, cacheRead: 4000, cacheWrite: writes({ '30m': 3000, '12h': 4000 }), output: 500 } }))
    expect(out.cost.valueUsd).toBe('0.0349')
    expect(out.cost.valueUsd).not.toBe('0.0489')
    expect(out.cost.appliedRates.map((a) => a.rateKey)).toEqual([
      'input_cost_per_token',
      'cache_read_input_token_cost',
      'cache_creation_input_token_cost',
      'cache_creation_input_token_cost_above_12hr',
      'output_cost_per_token',
    ])
  })
})

describe('zero cases', () => {
  it('valid zero through an explicit zero rate (codestral/codestral-latest)', () => {
    expect(snapshot.models['codestral/codestral-latest']?.rates.input_cost_per_token).toMatch(/^0(\.0+)?$/)
    const out = price(row({
      variant: 'F-json',
      provider: 'codestral',
      modelLogged: 'codestral/codestral-latest',
      tierStated: null,
      tokens: { uncachedInput: 1200, output: 340 },
      reported: { amountUsd: '0', field: 'spend', kind: 'gateway_estimate' },
    }))
    expect(out.cost.valueUsd).toBe('0')
    expect(out.cost.label.kind).toBe('Estimated')
    expect(out.cost.label.reason).toBe(`explicit zero rate in snapshot ${worked.snapshot.date}`)
    expect(out.labels.reportedCharge?.kind).toBe('Estimated')
    expect(out.labels.reportedCharge?.reason).toContain("gateway's own calculation")
  })

  it('valid zero through a reported charge of 0', () => {
    const out = price(row({
      variant: 'E-jsonl',
      provider: 'meta-llama',
      modelLogged: 'meta-llama/llama-3.3-70b-instruct:free',
      tierStated: null,
      tokens: { uncachedInput: 500, output: 120 },
      reported: { amountUsd: '0', field: 'usage.cost', kind: 'charge' },
    }))
    expect(out.cost.valueUsd).toBe('0')
    expect(out.cost.label.kind).toBe('Measured charge')
    expect(out.cost.label.reason).toContain('usage.cost')
    expect(out.labels.reportedCharge?.kind).toBe('Measured charge')
  })

  it('Not priced: an unknown model has a null value, never "0"', () => {
    const out = price(row({ modelLogged: 'unlisted-model-x', tokens: { uncachedInput: 100, output: 10 } }))
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.valueUsd).not.toBe('0')
    expect(out.cost.estimateUsd).toBeNull()
    expect(out.cost.label.kind).toBe('Not priced')
    expect(out.match.kind).toBe('none')
    expect(out.labels.model?.kind).toBe('Not priced')
  })

  it('Not priced even with gateway spend above zero when the model is unknown', () => {
    const out = price(row({ variant: 'F-csv', modelLogged: 'unlisted-model-x', tokens: { uncachedInput: 100 }, reported: { amountUsd: '0.01', field: 'spend', kind: 'gateway_estimate' } }))
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.label.kind).toBe('Not priced')
  })

  it('Unresolved: gateway spend 0 with a non-zero snapshot rate', () => {
    const out = price(row({
      variant: 'F-json',
      tokens: { uncachedInput: 1000, output: 200 },
      reported: { amountUsd: '0', field: 'spend', kind: 'gateway_estimate' },
    }))
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.label.kind).toBe('Unresolved')
    expect(out.cost.label.reason).toBe("gateway logged spend 0 but the snapshot rate is not zero; review needed")
    expect(out.cost.estimateUsd).toBe('0.0045')
  })

  it('gateway spend above zero keeps the estimate as the value', () => {
    const out = price(row({ variant: 'F-json', tokens: { uncachedInput: 1000, output: 200 }, reported: { amountUsd: '0.0045', field: 'spend', kind: 'gateway_estimate' } }))
    expect(out.cost.valueUsd).toBe('0.0045')
    expect(out.cost.label).toEqual({ kind: 'Estimated', reason: 'tokens times snapshot rate' })
  })

  it('a row with unresolvedReason is Unresolved even with a charge', () => {
    const out = price(row({ unresolvedReason: 'cache tokens exceed input tokens', flags: ['cache_exceeds_input'], reported: { amountUsd: '1', field: 'usage.cost', kind: 'charge' } }))
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.label).toEqual({ kind: 'Unresolved', reason: 'cache tokens exceed input tokens' })
  })

  it('a malformed row is Unresolved', () => {
    const out = price(row({ modelLogged: null, tierStated: null, flags: ['malformed'], unresolvedReason: 'Malformed: bad JSON' }))
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.label.kind).toBe('Unresolved')
  })
})

describe('model resolution', () => {
  it('a dated version without an alias is Not priced', () => {
    expect(snapshot.models['gpt-4o-2099-01-01']).toBeUndefined()
    const out = price(row({ modelLogged: 'gpt-4o-2099-01-01', tokens: { uncachedInput: 10 } }))
    expect(out.match.kind).toBe('none')
    expect(out.cost.label.kind).toBe('Not priced')
  })

  it('a gateway-prefixed name without an alias is Not priced', () => {
    expect(snapshot.models['myproxy/gpt-4o']).toBeUndefined()
    const out = price(row({ modelLogged: 'myproxy/gpt-4o', tokens: { uncachedInput: 10 } }))
    expect(out.resolvedKey).toBeNull()
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.label.kind).toBe('Not priced')
  })

  it('the alias openai/gpt-4o resolves to gpt-4o and shows its source', () => {
    expect(snapshot.models['openai/gpt-4o']).toBeUndefined()
    const out = price(row({ variant: 'E-json', modelLogged: 'openai/gpt-4o', tokens: { uncachedInput: 86, cacheRead: 1920, output: 300 } }))
    expect(out.resolvedKey).toBe('gpt-4o')
    expect(out.match.kind).toBe('alias')
    expect(out.match.source).toBe('https://openrouter.ai/api/v1/models')
    expect(out.labels.model?.reason).toContain('https://openrouter.ai/api/v1/models')
    expect(out.cost.valueUsd).toBe('0.005615')
  })

  it('every alias carries a source URL and points at a snapshot key', () => {
    for (const a of ALIASES) {
      expect(a.source).toMatch(/^https:\/\//)
      expect(snapshot.models[a.to]).toBeDefined()
      expect(resolveModel(a.from, snapshot.models).key).toBe(a.to)
    }
    expect(resolveModel(null, snapshot.models).match.kind).toBe('none')
  })
})

describe('tiers', () => {
  it('an unstated tier is priced as standard with the tier assumed label', () => {
    const out = price(row({ tierStated: null, tokens: { uncachedInput: 86, cacheRead: 1920, output: 300 } }))
    expect(out.tierApplied).toBe('standard')
    expect(out.flags).toContain('tier_assumed')
    expect(out.labels.tier?.kind).toBe('Estimated')
    expect(out.labels.tier?.reason).toMatch(/^tier assumed/)
    expect(out.cost.valueUsd).toBe('0.005615')
  })

  it('a stated tier is labelled Measured and not flagged', () => {
    const out = price(row({ tokens: { uncachedInput: 1 } }))
    expect(out.flags).not.toContain('tier_assumed')
    expect(out.labels.tier).toEqual({ kind: 'Measured', reason: 'stated in source: standard' })
  })

  it('a stated batch tier uses the _batches keys', () => {
    const out = price(row({
      variant: 'D-json',
      provider: 'anthropic',
      modelLogged: 'claude-sonnet-4-5-20250929',
      tierStated: 'batch',
      tokens: { uncachedInput: 2048, cacheRead: 1800, cacheWrite: writes({ '5m': 148 }), output: 503 },
    }))
    expect(out.cost.appliedRates.map((a) => a.rateKey)).toEqual([
      'input_cost_per_token_batches',
      'cache_read_input_token_cost_batches',
      'cache_creation_input_token_cost_batches',
      'output_cost_per_token_batches',
    ])
    // 2048 x 0.0000015 + 1800 x 0.00000015 + 148 x 0.000001875 + 503 x 0.0000075
    expect(out.cost.valueUsd).toBe('0.007392')
  })

  it('a stated tier with no matching key is Not priced and names the key', () => {
    const out = price(row({ tierStated: 'batch', tokens: { uncachedInput: 100, cacheRead: 100 } }))
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.label.kind).toBe('Not priced')
    expect(out.cost.label.reason).toContain('cache_read_input_token_cost_batches')
  })

  it('a 1h write on batch has no _above_1hr_batches key, so it is Not priced', () => {
    const out = price(row({ modelLogged: 'claude-sonnet-4-5-20250929', tierStated: 'batch', tokens: { cacheWrite: writes({ '1h': 10 }) } }))
    expect(out.cost.label.kind).toBe('Not priced')
    expect(out.cost.label.reason).toContain('cache_creation_input_token_cost_above_1hr_batches')
  })

  it('scale tier, fast mode and regional inference are Not priced', () => {
    expect(price(row({ tierStated: null, raw: { service_tier: 'scale' }, tokens: { uncachedInput: 5 } })).cost.label).toEqual({
      kind: 'Not priced',
      reason: 'scale tier has no rate in the snapshot',
    })
    const scale = price(row({ tierStated: null, raw: { service_tier: 'scale' }, tokens: { uncachedInput: 5 } }))
    expect(scale.flags).not.toContain('tier_assumed')
    expect(scale.labels.tier).toEqual({ kind: 'Measured', reason: 'stated in source: scale; the snapshot has no rate for this tier' })
    expect(scale.labels.tier?.reason).not.toContain('assumed')
    expect(scale.cost.estimateLabel.reason).not.toContain('tier assumed')
    const scaleNested = price(row({ tierStated: null, raw: { 'response.service_tier': 'Scale' }, tokens: { uncachedInput: 5 } }))
    expect(scaleNested.flags).not.toContain('tier_assumed')
    expect(scaleNested.labels.tier?.reason).toMatch(/^stated in source: scale/)
    const fast = price(row({ modelLogged: 'claude-sonnet-4-5-20250929', raw: { 'usage.speed': 'fast' }, tokens: { uncachedInput: 5 } }))
    expect(fast.cost.label.kind).toBe('Not priced')
    const geo = price(row({ modelLogged: 'claude-sonnet-4-5-20250929', raw: { 'usage.inference_geo': 'us' }, tokens: { uncachedInput: 5 } }))
    expect(geo.cost.label.kind).toBe('Not priced')
    const global = price(row({ modelLogged: 'claude-sonnet-4-5-20250929', raw: { 'usage.inference_geo': 'global', 'usage.speed': 'standard' }, tokens: { uncachedInput: 5 } }))
    expect(global.cost.label.kind).toBe('Estimated')
  })
})

describe('cache write durations', () => {
  it('a duration_assumed flag passes through and shows on the cacheWrite label', () => {
    const out = price(row({
      variant: 'D-json',
      modelLogged: 'claude-sonnet-4-5-20250929',
      flags: ['duration_assumed'],
      tokens: { uncachedInput: 10, cacheWrite: writes({ '5m': 248 }), output: 5 },
      mapping: ['cacheWrite.5m = usage.cache_creation_input_tokens (duration assumed)'],
    }))
    expect(out.flags).toContain('duration_assumed')
    expect(out.labels.cacheWrite?.kind).toBe('Measured')
    expect(out.labels.cacheWrite?.reason).toContain('duration assumed')
    expect(out.cost.appliedRates.find((a) => a.tokenClass === 'cacheWrite.5m')?.rateKey).toBe('cache_creation_input_token_cost')
  })

  it('OpenAI-family durations on an Anthropic model are Not priced', () => {
    const out = price(row({ modelLogged: 'claude-sonnet-4-5-20250929', tokens: { cacheWrite: writes({ '30m': 10 }) } }))
    expect(out.cost.label.kind).toBe('Not priced')
  })

  it('an OpenAI-family model with no cache_creation key bills writes at the input rate', () => {
    const out = price(row({ tokens: { uncachedInput: 100, cacheWrite: writes({ '30m': 100 }) } }))
    expect(out.cost.valueUsd).toBe('0.0005')
    expect(out.cost.appliedRates[1]?.rateKey).toBe('input_cost_per_token')
    expect(out.cost.label.reason).toContain('ordinary input rate')
    const fiveMin = price(row({ tokens: { cacheWrite: writes({ '5m': 100 }) } }))
    expect(fiveMin.cost.label.kind).toBe('Not priced')
  })

  it('writes on other provider families have no duration mapping', () => {
    const out = price(row({ modelLogged: 'gemini-2.5-flash', provider: 'google', tokens: { cacheWrite: writes({ '5m': 10 }) } }))
    expect(providerFamily('gemini-2.5-flash', snapshot.models['gemini-2.5-flash']!)).toBe('other')
    expect(out.cost.label.kind).toBe('Not priced')
    expect(out.cost.label.reason).toContain('no documented duration mapping')
  })
})

describe('long context and time buckets', () => {
  it('gpt-6.1-sol has a 272k threshold', () => {
    expect(contextThresholds(snapshot.models['gpt-6.1-sol']!)).toEqual([272000])
    expect(rateKey('cache_creation_input_token_cost', '_above_12hr', 272000, 'priority')).toBe('cache_creation_input_token_cost_above_12hr_above_272k_tokens_priority')
  })

  it('total input above 272k uses the _above_272k_tokens keys', () => {
    const out = price(row({
      variant: 'B-json',
      modelLogged: 'gpt-6.1-sol',
      tokens: { uncachedInput: 250000, cacheRead: 20000, cacheWrite: writes({ '30m': 3000 }), output: 1000 },
    }))
    expect(out.flags).toContain('long_context_applied')
    expect(out.cost.appliedRates.map((a) => a.rateKey)).toEqual([
      'input_cost_per_token_above_272k_tokens',
      'cache_read_input_token_cost_above_272k_tokens',
      'cache_creation_input_token_cost_above_272k_tokens',
      'output_cost_per_token_above_272k_tokens',
    ])
    // 250000 x 0.000004 + 20000 x 0.0000002 + 3000 x 0.000005 + 1000 x 0.000015
    expect(out.cost.valueUsd).toBe('1.034')
  })

  it('exactly 272k input stays on base rates', () => {
    const out = price(row({ modelLogged: 'gpt-6.1-sol', tokens: { uncachedInput: 272000, output: 1 } }))
    expect(out.flags).not.toContain('long_context_applied')
    expect(out.cost.appliedRates[0]?.rateKey).toBe('input_cost_per_token')
  })

  it('long context composes with the tier suffix', () => {
    const out = price(row({ modelLogged: 'gpt-6.1-sol', tierStated: 'priority', tokens: { uncachedInput: 300000, cacheWrite: writes({ '12h': 10 }) } }))
    expect(out.cost.appliedRates.map((a) => a.rateKey)).toEqual([
      'input_cost_per_token_above_272k_tokens_priority',
      'cache_creation_input_token_cost_above_12hr_above_272k_tokens_priority',
    ])
  })

  it('long context on the batch tier uses the batch long context key', () => {
    const out = price(row({ modelLogged: 'gpt-6.1-sol', tierStated: 'batch', tokens: { uncachedInput: 300000 } }))
    expect(out.cost.appliedRates[0]?.rateKey).toBe('input_cost_per_token_above_272k_tokens_batches')
    expect(out.cost.valueUsd).toBe('0.6')
  })

  it('a long context request without the needed key for a class with tokens is Not priced', () => {
    const e = createPricingEngine(snapshot, meta, [{ model: 'gpt-4o', rateKey: 'input_cost_per_token_above_128k_tokens', rateUsdPerToken: '0.000005' }])
    const out = e.price(row({ tokens: { uncachedInput: 200000, output: 10 } }))
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.label.kind).toBe('Not priced')
    expect(out.cost.label.reason).toContain('output_cost_per_token_above_128k_tokens')
    const inputOnly = e.price(row({ tokens: { uncachedInput: 200000 } }))
    expect(inputOnly.cost.valueUsd).toBe('1')
  })

  it('excluded image, audio and video input tokens count toward the threshold but are not priced', () => {
    // Provider prompt 275,000 with 5,000 image tokens: the adapter leaves 270,000 priced input.
    const out = price(row({
      modelLogged: 'gpt-6.1-sol',
      excluded: { input_image: 5000 },
      mapping: ['uncachedInput = usage.prompt_tokens - prompt_tokens_details.image_tokens (excluded)'],
      tokens: { uncachedInput: 270000, output: 100 },
    }))
    expect(out.flags).toContain('long_context_applied')
    expect(out.cost.appliedRates.map((a) => [a.tokenClass, a.tokens, a.rateKey])).toEqual([
      ['uncachedInput', 270000, 'input_cost_per_token_above_272k_tokens'],
      ['output', 100, 'output_cost_per_token_above_272k_tokens'],
    ])
    // 270000 x 0.000004 + 100 x 0.000015; the 5,000 image tokens are not priced
    expect(out.cost.valueUsd).toBe('1.0815')
    expect(out.cost.formula).toContain('contextSize = 270,000 priced input + 5,000 excluded.input_image = 275,000 tokens')
    expect(out.mapping.at(-1)).toMatch(/^contextSize = .*threshold only and are not priced\)$/)
    expect(out.cost.estimateLabel.reason).toContain('275,000 in this request, including 5,000 excluded image, audio or video input tokens')

    const audioVideo = price(row({ modelLogged: 'gpt-6.1-sol', excluded: { input_audio: 1500, input_video: 1000, output_audio: 900000 }, tokens: { uncachedInput: 270000 } }))
    expect(audioVideo.flags).toContain('long_context_applied')
    expect(audioVideo.cost.valueUsd).toBe('1.08')
    // Excluded output modalities never count as prompt size.
    const outputOnly = price(row({ modelLogged: 'gpt-6.1-sol', excluded: { output_image: 900000 }, tokens: { uncachedInput: 270000 } }))
    expect(outputOnly.flags).not.toContain('long_context_applied')
    expect(outputOnly.cost.valueUsd).toBe('0.54')
    expect(outputOnly.mapping).toEqual([])
  })

  it('time bucket rows use base rates with a label and flag', () => {
    const out = price(row({
      variant: 'C-page',
      granularity: 'time_bucket',
      requests: 5,
      modelLogged: 'gpt-6.1-sol',
      tokens: { uncachedInput: 900000, output: 1000 },
    }))
    expect(out.flags).toContain('long_context_not_applied_bucket')
    expect(out.flags).not.toContain('long_context_applied')
    expect(out.cost.appliedRates[0]?.rateKey).toBe('input_cost_per_token')
    expect(out.cost.estimateLabel.reason).toContain('time bucket priced at base rates')
    expect(out.cost.valueUsd).toBe('1.81')
  })

  it('time bucket rows on a model without thresholds get no bucket flag', () => {
    const out = price(row({ variant: 'C-page', granularity: 'time_bucket', requests: 2, tokens: { uncachedInput: 500000 } }))
    expect(out.flags).not.toContain('long_context_not_applied_bucket')
  })
})

describe('reasoning, charges, labels', () => {
  it('a model with a reasoning rate prices reasoning separately', () => {
    const out = price(row({ modelLogged: 'gemini-2.5-flash', provider: 'google', tokens: { uncachedInput: 1000, output: 1186, reasoning: 1024 } }))
    expect(out.cost.appliedRates.map((a) => [a.tokenClass, a.tokens, a.rateKey])).toEqual([
      ['uncachedInput', 1000, 'input_cost_per_token'],
      ['output', 162, 'output_cost_per_token'],
      ['reasoning', 1024, 'output_cost_per_reasoning_token'],
    ])
  })

  it('a stated tier with measured reasoning uses the tier output rate when the base reasoning and output rates are equal', () => {
    const r = { modelLogged: 'gemini/gemini-2.5-flash', provider: 'gemini', variant: 'H-csv' as const }
    expect(snapshot.models['gemini/gemini-2.5-flash']?.rates.output_cost_per_reasoning_token_batches).toBeUndefined()
    const batch = price(row({ ...r, tierStated: 'batch', tokens: { uncachedInput: 1000, output: 1000, reasoning: 400 } }))
    expect(batch.cost.label.kind).toBe('Estimated')
    expect(batch.cost.appliedRates.map((a) => [a.tokenClass, a.tokens, a.rateKey])).toEqual([
      ['uncachedInput', 1000, 'input_cost_per_token_batches'],
      ['output', 600, 'output_cost_per_token_batches'],
      ['reasoning', 400, 'output_cost_per_token_batches'],
    ])
    // Same as the row with reasoning not measured: 1000 x 0.00000015 + 1000 x 0.00000125
    expect(batch.cost.valueUsd).toBe('0.0014')
    expect(price(row({ ...r, tierStated: 'batch', tokens: { uncachedInput: 1000, output: 1000 } })).cost.valueUsd).toBe('0.0014')
    expect(batch.cost.estimateLabel.reason).toContain('reasoning tokens at the output rate')
    for (const tier of ['flex', 'priority'] as const) {
      expect(price(row({ ...r, tierStated: tier, tokens: { uncachedInput: 1000, output: 1000, reasoning: 400 } })).cost.label.kind).toBe('Estimated')
    }
  })

  it('a stated tier uses the tiered reasoning key when present', () => {
    const e = createPricingEngine(snapshot, meta, [{ model: 'gemini-2.5-flash', rateKey: 'output_cost_per_reasoning_token_flex', rateUsdPerToken: '0.000002' }])
    const out = e.price(row({ modelLogged: 'gemini-2.5-flash', provider: 'google', tierStated: 'flex', tokens: { output: 1000, reasoning: 400 } }))
    expect(out.cost.appliedRates.map((a) => [a.tokenClass, a.rateKey])).toEqual([
      ['output', 'output_cost_per_token_flex'],
      ['reasoning', 'output_cost_per_reasoning_token_flex'],
    ])
    // 600 x 0.00000125 + 400 x 0.000002
    expect(out.cost.valueUsd).toBe('0.00155')
  })

  it('a stated tier with a distinct base reasoning rate and no tiered reasoning key is Not priced and names the key', () => {
    const e = createPricingEngine(snapshot, meta, [{ model: 'gemini-2.5-flash', rateKey: 'output_cost_per_reasoning_token', rateUsdPerToken: '0.000003' }])
    const out = e.price(row({ modelLogged: 'gemini-2.5-flash', provider: 'google', tierStated: 'flex', tokens: { output: 1000, reasoning: 400 } }))
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.label.kind).toBe('Not priced')
    expect(out.cost.label.reason).toContain('missing rate key output_cost_per_reasoning_token_flex')
    // Standard tier still uses the base reasoning rate.
    const std = e.price(row({ modelLogged: 'gemini-2.5-flash', provider: 'google', tokens: { output: 1000, reasoning: 400 } }))
    expect(std.cost.appliedRates.find((a) => a.tokenClass === 'reasoning')?.rateKey).toBe('output_cost_per_reasoning_token')
  })

  it('a model without a reasoning rate prices all output at the output rate', () => {
    const out = price(row({ tokens: { output: 1186, reasoning: 1024 } }))
    expect(out.cost.appliedRates).toHaveLength(1)
    expect(out.cost.appliedRates[0]?.tokens).toBe(1186)
    expect(out.labels.reasoning?.kind).toBe('Measured')
  })

  it('a charge more than 1% away from the estimate is flagged', () => {
    const out = price(row({ variant: 'E-json', modelLogged: 'openai/gpt-4o', tokens: { uncachedInput: 86, cacheRead: 1920, output: 300 }, reported: { amountUsd: '0.95', field: 'usage.cost', kind: 'charge' } }))
    expect(out.cost.valueUsd).toBe('0.95')
    expect(out.flags).toContain('cost_inconsistent')
    const close = price(row({ variant: 'E-json', modelLogged: 'openai/gpt-4o', tokens: { uncachedInput: 86, cacheRead: 1920, output: 300 }, reported: { amountUsd: '0.00562', field: 'usage.cost', kind: 'charge' } }))
    expect(close.flags).not.toContain('cost_inconsistent')
  })

  it('a charge on an unknown model is still the value', () => {
    const out = price(row({ variant: 'E-json', modelLogged: 'unlisted/unknown', tokens: { uncachedInput: 1 }, reported: { amountUsd: '0.00014', field: 'usage.cost', kind: 'charge' } }))
    expect(out.cost.valueUsd).toBe('0.00014')
    expect(out.cost.label.kind).toBe('Measured charge')
    expect(out.cost.estimateLabel.kind).toBe('Not priced')
  })

  it('a missing model is flagged and Not priced', () => {
    const out = price(row({ variant: 'C-page', granularity: 'time_bucket', modelLogged: null, tierStated: null, tokens: { uncachedInput: 1 } }))
    expect(out.flags).toContain('model_missing')
    expect(out.cost.label.kind).toBe('Not priced')
  })

  it('labels cover every value with a reason', () => {
    const out = price(row({
      notMeasured: ['cacheWrite', 'reasoning'],
      mapping: ['uncachedInput = usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens', 'cacheRead = usage.prompt_tokens_details.cached_tokens', 'output = usage.completion_tokens'],
      tokens: { uncachedInput: 86, cacheRead: 1920, output: 300 },
    }))
    for (const k of ['uncachedInput', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'reportedCharge', 'estimate', 'value', 'tier', 'model', 'price']) {
      expect(out.labels[k]?.reason.length).toBeGreaterThan(0)
    }
    expect(out.labels.uncachedInput).toEqual({ kind: 'Measured', reason: 'as logged in usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens' })
    expect(out.labels.cacheWrite).toEqual({ kind: 'Not measured', reason: 'absent in source' })
    expect(out.labels.reasoning?.kind).toBe('Not measured')
    expect(out.labels.reportedCharge).toEqual({ kind: 'Not measured', reason: 'absent in source' })
    expect(out.labels.price?.reason).toBe(priceLabel(worked.snapshot.date))
    expect(out.labels.price?.reason).toBe('current list price, snapshot 2026-10-29')
    expect(out.snapshot).toEqual(meta)
  })

  it('a row with no tokens on a priced model is a zero estimate with a reason', () => {
    const out = price(row({ tokens: {} }))
    expect(out.cost.valueUsd).toBe('0')
    expect(out.cost.label.reason).toBe('no billable tokens in this row')
  })

  it('overrides replace a rate', () => {
    const e = createPricingEngine(snapshot, meta, [{ model: 'gpt-4o', rateKey: 'input_cost_per_token', rateUsdPerToken: '0.000005' }])
    const out = e.price(row({ tokens: { uncachedInput: 1000 } }))
    expect(out.cost.valueUsd).toBe('0.005')
    expect(out.cost.label.reason).toContain('override applied')
  })
})

describe('absent billed token classes', () => {
  const charge = (amountUsd: string) => ({ amountUsd, field: 'usage.cost', kind: 'charge' as const })

  it('output absent with no charge is Unresolved, with the subtotal of the classes present beside it', () => {
    const out = price(row({ notMeasured: ['output'], tokens: { uncachedInput: 1000, cacheRead: 400 } }))
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.label).toEqual({ kind: 'Unresolved', reason: 'output tokens missing, cost would be understated' })
    // 1,000 x 0.0000025 + 400 x 0.00000125
    expect(out.cost.estimateUsd).toBe('0.003')
    expect(out.cost.estimateLabel).toEqual({ kind: 'Estimated', reason: 'subtotal of the classes present; not counted in totals' })
    expect(out.flags).toContain('billed_class_missing')
    expect(out.flags).not.toContain('estimate_incomplete')
    expect(out.labels.output).toEqual({ kind: 'Not measured', reason: 'absent in source' })
  })

  it('input absent names input, and both absent name both', () => {
    expect(price(row({ notMeasured: ['uncachedInput'], tokens: { output: 10 } })).cost.label.reason).toBe('input tokens missing, cost would be understated')
    const both = price(row({ notMeasured: ['uncachedInput', 'output'], tokens: { cacheRead: 100 } }))
    expect(both.cost.label).toEqual({ kind: 'Unresolved', reason: 'input and output tokens missing, cost would be understated' })
    expect(both.cost.estimateUsd).toBe('0.000125')
  })

  it('a Measured charge keeps the row, with the estimate marked incomplete', () => {
    const out = price(row({ variant: 'E-json', notMeasured: ['output'], reported: charge('0.95'), tokens: { uncachedInput: 1000 } }))
    expect(out.cost.valueUsd).toBe('0.95')
    expect(out.cost.label).toEqual({ kind: 'Measured charge', reason: 'as logged in usage.cost' })
    expect(out.flags).toEqual(expect.arrayContaining(['billed_class_missing', 'estimate_incomplete']))
    // An incomplete estimate is not compared with the charge.
    expect(out.flags).not.toContain('cost_inconsistent')
    expect(out.cost.estimateUsd).toBe('0.0025')
    expect(out.cost.estimateLabel.kind).toBe('Estimated')
    expect(out.cost.estimateLabel.reason.startsWith('incomplete: output tokens missing; ')).toBe(true)
    // A charge of 0 is still a valid zero.
    expect(price(row({ variant: 'E-json', notMeasured: ['output'], reported: charge('0'), tokens: { uncachedInput: 1000 } })).cost.valueUsd).toBe('0')
  })

  it('a Measured charge on a model the snapshot cannot price keeps the charge and no estimate', () => {
    const out = price(row({ variant: 'E-json', modelLogged: 'unlisted/unknown', notMeasured: ['output'], reported: charge('0.00014'), tokens: { uncachedInput: 1 } }))
    expect(out.cost).toMatchObject({ valueUsd: '0.00014', estimateUsd: null })
    expect(out.cost.estimateLabel.kind).toBe('Not priced')
    expect(out.flags).toContain('estimate_incomplete')
  })

  it('a gateway spend does not keep the row; it still shows as the reported amount', () => {
    const out = price(row({ variant: 'F-json', notMeasured: ['output'], reported: { amountUsd: '0.5', field: 'spend', kind: 'gateway_estimate' }, tokens: { uncachedInput: 1000 } }))
    expect(out.cost.valueUsd).toBeNull()
    expect(out.cost.label).toEqual({ kind: 'Unresolved', reason: 'output tokens missing, cost would be understated' })
    expect(out.labels.reportedCharge).toEqual({ kind: 'Estimated', reason: "gateway's own calculation (spend)" })
    expect(out.flags).not.toContain('estimate_incomplete')
  })

  it('an unreadable charge does not keep the row either', () => {
    const out = price(row({ variant: 'E-json', notMeasured: ['output'], reported: charge('-0.5'), tokens: { uncachedInput: 1000 } }))
    expect(out.cost.label.reason).toBe('output tokens missing, cost would be understated')
  })

  it('an embedding call never needs output', () => {
    const out = price(row({ operation: 'embedding', notMeasured: ['output', 'reasoning'], tokens: { uncachedInput: 1000 } }))
    expect(out.cost).toMatchObject({ valueUsd: '0.0025', label: { kind: 'Estimated' } })
    expect(out.flags).not.toContain('billed_class_missing')
    const noInput = price(row({ operation: 'embedding', notMeasured: ['uncachedInput', 'output'], tokens: {} }))
    expect(noInput.cost.label.reason).toBe('input tokens missing, cost would be understated')
  })

  it('an explicit 0 is measured and stays a valid zero', () => {
    const out = price(row({ tokens: { uncachedInput: 0, output: 0 } }))
    expect(out.cost.valueUsd).toBe('0')
    expect(out.flags).not.toContain('billed_class_missing')
  })

  it('other absent classes, an unresolvedReason and a malformed row keep their own outcome', () => {
    expect(price(row({ notMeasured: ['cacheRead', 'cacheWrite', 'reasoning'], tokens: { uncachedInput: 1000 } })).cost.valueUsd).toBe('0.0025')
    const unresolved = price(row({ notMeasured: ['output'], unresolvedReason: 'cache tokens exceed input tokens', tokens: { uncachedInput: 1 } }))
    expect(unresolved.cost.label.reason).toBe('cache tokens exceed input tokens')
    expect(unresolved.flags).not.toContain('billed_class_missing')
    const malformed = price(row({ notMeasured: ['output'], flags: ['malformed'] }))
    expect(malformed.cost.label.reason).toBe('malformed row')
    expect(malformed.flags).not.toContain('billed_class_missing')
  })
})
