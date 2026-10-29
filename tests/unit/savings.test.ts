import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DecimalString,
  DEFAULT_DURATION_MAP,
  PricingSnapshot,
  type AuditRow,
  type CacheDuration,
  type FrozenSnapshot,
  type NormalizedUsageRow,
  type RoutingAssumptions,
  type ScenarioResult,
} from '../../src/engine/contracts'
import { decimalToScaled, scaledToDecimal } from '../../src/engine/money'
import { createPricingEngine } from '../../src/engine/pricing'
import {
  ASSUMPTION_LABEL,
  BASELINE_LABEL,
  canonicalDecimal,
  canonicalRoutingAssumptions,
  createScenario,
  ROUTING_SCALE_DIGITS,
  SavingsInputError,
  toNormalized,
  transformRow,
} from '../../src/engine/savings'

const ROOT = join(__dirname, '..', '..')
const worked = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'worked-examples.json'), 'utf8')) as {
  snapshot: { file: string; date: string; sha256: string; commit: string }
}
const snapshot = PricingSnapshot.parse(JSON.parse(readFileSync(join(ROOT, 'public', 'pricing', worked.snapshot.file), 'utf8')))
const meta: FrozenSnapshot = { file: worked.snapshot.file, date: worked.snapshot.date, sha256: worked.snapshot.sha256, commit: worked.snapshot.commit }
const engine = createPricingEngine(snapshot, meta)
const ONE = 1_000_000n

function writes(w: Partial<Record<CacheDuration, number>> = {}): NormalizedUsageRow['tokens']['cacheWrite'] {
  return { '5m': 0, '1h': 0, '30m': 0, '12h': 0, ...w }
}

function row(model: string, tokens: Partial<NormalizedUsageRow['tokens']>, over: Partial<NormalizedUsageRow> = {}): AuditRow {
  return engine.price({
    rowIndex: 0,
    timestamp: '2026-10-01T00:00:00.000Z',
    variant: 'A-json',
    provider: model.startsWith('claude') ? 'anthropic' : 'openai',
    modelLogged: model,
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
    ...over,
    tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: writes(), output: 0, reasoning: null, ...tokens },
  })
}

// 10,000 x 0.0000025 + 5,000 x 0.00000125 + 2,000 x 0.00001 = 0.05125 (input band 10k-100k)
const gpt = row('gpt-4o', { uncachedInput: 10000, cacheRead: 5000, output: 2000 })
// 2,000 x 0.000003 + 1,000 x 0.0000003 + 400 x 0.00000375 + 800 x 0.000015 = 0.0198 (input band 1k-10k)
const sonnet = row('claude-sonnet-4-5-20250929', { uncachedInput: 2000, cacheRead: 1000, cacheWrite: writes({ '5m': 400 }), output: 800 })
const rows = [gpt, sonnet]

function routing(over: Partial<RoutingAssumptions> = {}): RoutingAssumptions {
  return {
    sourceModels: ['claude-sonnet-4-5-20250929'],
    inputBands: [],
    targetModel: 'gpt-4o-mini',
    eligibleShare: '0.5',
    outputLengthRatio: '1',
    tokenizerRatio: '1',
    retryFallbackRate: '0',
    routingOverheadTokens: 0,
    calibrationPassRate: null,
    ...over,
  }
}

function route(over: Partial<RoutingAssumptions> = {}, input: readonly AuditRow[] = rows): NonNullable<ScenarioResult['routing']> & { result: ScenarioResult } {
  const s = createScenario({ snapshot, snapshotMeta: meta, baselineKey: null, routing: routing(over), durationMap: DEFAULT_DURATION_MAP })
  s.add(input)
  const result = s.result(0)
  return { ...result.routing!, result }
}

function baseline(key: string, input: readonly AuditRow[] = rows): NonNullable<ScenarioResult['baseline']> {
  const s = createScenario({ snapshot, snapshotMeta: meta, baselineKey: key, routing: null, durationMap: DEFAULT_DURATION_MAP })
  s.add(input)
  return s.result(0).baseline!
}

describe('baseline', () => {
  it('reprices every compared row at the baseline list price', () => {
    expect(gpt.cost.estimateUsd).toBe('0.05125')
    expect(sonnet.cost.estimateUsd).toBe('0.0198')
    const b = baseline('gpt-4o-mini')
    expect(b.label).toBe(BASELINE_LABEL)
    expect(b.label).toBe('Modelled: the baseline never ran')
    expect(b.comparedOriginal.exactUsd).toBe('0.07105')
    // row 1: 0.0015 + 0.000375 + 0.0012; row 2: 0.0003 + 0.000075 + 0.00006 (writes at the input rate) + 0.00048
    expect(b.value.exactUsd).toBe('0.00399')
    expect(b.difference).toEqual({ exactUsd: '-0.06706', displayUsd: '-$0.067060' })
    expect(b.rowsPriced).toBe(2)
    expect(b.rowsNotPriced).toBe(0)
  })

  it('uses the baseline write rate for the mapped duration', () => {
    // row 1: 0.03 + 0.0015 + 0.03; row 2 equals its list price
    expect(baseline('claude-sonnet-4-5-20250929').value.exactUsd).toBe('0.0813')
  })
})

describe('routing', () => {
  it('moves the eligible share to the target', () => {
    const r = route()
    expect(r.result.listOriginal.exactUsd).toBe('0.07105')
    // 0.05125 + 0.0198 x 0.5 + 0.000915 x 0.5
    expect(r.scenario.exactUsd).toBe('0.0616075')
    expect(r.savings.exactUsd).toBe('0.0094425')
    expect(r.eligibleRows).toBe(1)
    expect(r.result.rowsCompared).toBe(2)
    expect(r.result.quality).toBe('unverified')
    expect(r.result.label.kind).toBe('Estimated')
    expect(r.result.assumptions.join(' ')).toContain(ASSUMPTION_LABEL)
  })

  it('applies retries, calibration fallback, overhead and ratios exactly', () => {
    expect(route({ retryFallbackRate: '0.1' }).savings.exactUsd).toBe('0.00939675')
    expect(route({ calibrationPassRate: '0.8' }).savings.exactUsd).toBe('0.0074625')
    // 100 overhead tokens x 0.00000015 x 0.5 = 0.0000075 more
    expect(route({ routingOverheadTokens: 100 }).savings.exactUsd).toBe('0.009435')
    // target cost 0.00081 x 0.5 = 0.000405
    expect(route({ tokenizerRatio: '1.2', outputLengthRatio: '0.5' }).savings.exactUsd).toBe('0.009495')
  })

  it('a share of zero changes nothing, and a share of one moves everything', () => {
    expect(route({ eligibleShare: '0' }).savings.exactUsd).toBe('0')
    expect(route({ eligibleShare: '1' }).scenario.exactUsd).toBe('0.052165')
  })

  it('shows a negative result when the scenario costs more', () => {
    const r = route({ sourceModels: ['gpt-4o'], targetModel: 'claude-sonnet-4-5-20250929', eligibleShare: '1' })
    expect(r.savings.exactUsd).toBe('-0.01025')
    expect(r.savings.displayUsd).toBe('-$0.010250')
  })

  it('filters by the input band of each row and accepts empty lists as all', () => {
    expect(route({ inputBands: ['>=100k'] }).eligibleRows).toBe(0)
    expect(route({ sourceModels: [], inputBands: ['1k-10k'] }).eligibleRows).toBe(1)
    expect(route({ sourceModels: [], inputBands: ['1k-10k', '10k-100k'] }).eligibleRows).toBe(2)
    expect(route({ sourceModels: [] }).eligibleRows).toBe(2)
  })

  it('matches source models on the logged model name', () => {
    const aliased = row('openai/gpt-4o', { uncachedInput: 100 })
    expect(route({ sourceModels: ['gpt-4o'] }, [aliased]).eligibleRows).toBe(0)
    expect(route({ sourceModels: ['openai/gpt-4o'] }, [aliased]).eligibleRows).toBe(1)
  })

  it('keeps exact decimal text at the documented scale and never rounds the result', () => {
    const r = route({ eligibleShare: '0.333333', tokenizerRatio: '1.111111', outputLengthRatio: '0.777777', retryFallbackRate: '0.012345', calibrationPassRate: '0.654321' })
    for (const v of [r.result.listOriginal, r.scenario, r.savings]) expect(DecimalString.safeParse(v.exactUsd).success).toBe(true)
    const at = (t: string) => decimalToScaled(t, ROUTING_SCALE_DIGITS)
    expect(at(r.result.listOriginal.exactUsd) - at(r.scenario.exactUsd)).toBe(at(r.savings.exactUsd))
    expect(r.result.assumptions.join(' ')).toContain(`exact decimals at 1e-${ROUTING_SCALE_DIGITS} USD`)
  })

  it('a product finer than 1e-15 USD is kept exactly', () => {
    // One output token on gpt-4o (0.00001) routed to gpt-4o-mini (one output token, 0.0000006).
    const one = row('gpt-4o', { output: 1 })
    const r = route({ sourceModels: [], eligibleShare: '0.333333', retryFallbackRate: '0.012345', calibrationPassRate: '0.777777' }, [one])
    const orig = 10_000_000_000n
    const target = 600_000_000n
    const exact = (ONE - 333333n) * orig * ONE * ONE + 333333n * 1012345n * target * ONE + 333333n * 222223n * orig * ONE
    expect(ROUTING_SCALE_DIGITS).toBe(33)
    expect(r.scenario.exactUsd).toBe(scaledToDecimal(exact, 33))
    expect(r.scenario.exactUsd).toBe('0.000007609881390121')
    expect(r.savings.exactUsd).toBe('0.000002390118609879')
    expect(r.scenario.displayUsd).toBe('$0.000008')
    expect(r.savings.displayUsd).toBe('$0.000002')
  })

  it('display rounding is one half away from zero step on the exact value, with a minus sign for negatives', () => {
    // 10 gpt-4o-mini input tokens (0.0000015) become 1 gpt-4o input token (0.0000025) at tokenizer ratio 0.1.
    const down = route({ sourceModels: [], targetModel: 'gpt-4o', tokenizerRatio: '0.1' }, [row('gpt-4o-mini', { uncachedInput: 10 })])
    expect(down.savings).toEqual({ exactUsd: '-0.0000005', displayUsd: '-$0.000001' })
    // 1 gpt-4o input token (0.0000025) becomes 10 gpt-4o-mini input tokens (0.0000015).
    const up = route({ sourceModels: [], targetModel: 'gpt-4o-mini', tokenizerRatio: '10' }, [row('gpt-4o', { uncachedInput: 1 })])
    expect(up.savings).toEqual({ exactUsd: '0.0000005', displayUsd: '$0.000001' })
    expect(up.scenario).toEqual({ exactUsd: '0.000002', displayUsd: '$0.000002' })
  })

  it('canonical assumptions: set order and decimal spelling do not change the result', () => {
    const a = canonicalRoutingAssumptions(routing({ sourceModels: ['gpt-4o', 'claude-sonnet-4-5-20250929', 'gpt-4o'], inputBands: ['<1k', '1k-10k'], eligibleShare: '0.50', outputLengthRatio: '01.000', retryFallbackRate: '0.0', calibrationPassRate: '0.90' }))
    expect(a).toMatchObject({
      sourceModels: ['claude-sonnet-4-5-20250929', 'gpt-4o'],
      inputBands: ['1k-10k', '<1k'],
      eligibleShare: '0.5',
      outputLengthRatio: '1',
      retryFallbackRate: '0',
      calibrationPassRate: '0.9',
    })
    expect(canonicalDecimal('00.5')).toBe('0.5')
    expect(canonicalDecimal('-0.000')).toBe('0')
    expect(canonicalDecimal('12.3400')).toBe('12.34')
    const r1 = route({ sourceModels: ['gpt-4o', 'claude-sonnet-4-5-20250929'], eligibleShare: '0.50' }).result
    const r2 = route({ sourceModels: ['claude-sonnet-4-5-20250929', 'gpt-4o'], eligibleShare: '0.5' }).result
    expect(r1).toEqual(r2)
  })

  it('rejects invalid assumptions', () => {
    expect(() => route({ eligibleShare: '1.5' })).toThrow(SavingsInputError)
    expect(() => route({ eligibleShare: '-0.1' })).toThrow(SavingsInputError)
    expect(() => route({ tokenizerRatio: '0.1234567' })).toThrow(SavingsInputError)
    expect(() => route({ calibrationPassRate: '2' })).toThrow(SavingsInputError)
    expect(() => route({ routingOverheadTokens: -1 })).toThrow(SavingsInputError)
    expect(() => route({ targetModel: null })).toThrow(SavingsInputError)
    expect(() => route({ targetModel: 'unlisted-model-x' })).toThrow(SavingsInputError)
  })
})

describe('row transforms', () => {
  it('toNormalized drops the audit fields and the flags pricing adds', () => {
    const priced = row('gpt-6.1-sol', { uncachedInput: 300000 }, { tierStated: null, flags: ['duration_assumed'], excluded: { input_image: 10 } })
    expect(priced.flags).toEqual(expect.arrayContaining(['duration_assumed', 'tier_assumed', 'long_context_applied']))
    const n = toNormalized(priced)
    expect(n.flags).toEqual(['duration_assumed'])
    for (const k of ['resolvedKey', 'match', 'tierApplied', 'cost', 'labels', 'snapshot']) expect(k in n).toBe(false)
    expect(n.mapping.some((m) => m.startsWith('contextSize = '))).toBe(false)
    // A clean re-run gives the same cost.
    expect(engine.price(n).cost).toEqual(priced.cost)
  })

  it('scales each class by the ratios, rounding half up from the exact value', () => {
    const r = row('gpt-4o', { uncachedInput: 3, cacheRead: 1, cacheWrite: writes({ '30m': 5 }), output: 3, reasoning: 3 }, { requests: 4, excluded: { input_audio: 7, web_search_requests: 3 } })
    const t = transformRow(r, 'gpt-4o-mini', { models: engine.models, tokenizerRatio: 1_500_000n, outputLengthRatio: 500_000n, overheadTokens: 10n, durationMap: DEFAULT_DURATION_MAP })
    // 3 x 1.5 = 4.5 -> 5, plus 10 overhead x 4 requests
    expect(t.row.tokens.uncachedInput).toBe(45)
    // 1 x 1.5 = 1.5 -> 2
    expect(t.row.tokens.cacheRead).toBe(2)
    // 5 x 1.5 = 7.5 -> 8
    expect(t.row.tokens.cacheWrite).toEqual(writes({ '30m': 8 }))
    // 3 x 0.5 x 1.5 = 2.25 -> 2, reasoning the same and never above output
    expect(t.row.tokens.output).toBe(2)
    expect(t.row.tokens.reasoning).toBe(2)
    // Excluded input modalities scale for the threshold; other excluded counts stay.
    expect(t.row.excluded).toEqual({ input_audio: 11, web_search_requests: 3 })
    expect(t.row).toMatchObject({ modelLogged: 'gpt-4o-mini', reported: null, unresolvedReason: null, requests: 4, granularity: 'request' })
  })

  it('a ratio of 1 is the identity', () => {
    const r = row('gpt-6.1-sol', { uncachedInput: 12345, cacheRead: 777, cacheWrite: writes({ '30m': 3, '12h': 9 }), output: 99, reasoning: 33 })
    const t = transformRow(r, 'gpt-6.1-sol', { models: engine.models, tokenizerRatio: ONE, outputLengthRatio: ONE, overheadTokens: 0n, durationMap: DEFAULT_DURATION_MAP })
    expect(t.row.tokens).toEqual(r.tokens)
    expect(t).toMatchObject({ tierDropped: false, durationsMapped: false })
  })
})
