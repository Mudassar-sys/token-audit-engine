import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DURATION_MAP,
  PricingSnapshot,
  ScenarioResult,
  type AuditRow,
  type CacheDuration,
  type FrozenSnapshot,
  type NormalizedUsageRow,
  type RoutingAssumptions,
  type ScenarioRequest,
} from '../../src/engine/contracts'
import { createPricingEngine } from '../../src/engine/pricing'
import { createScenario, LEFT_OUT, LOGGED_VERSUS_LIST_LABEL, TIME_BUCKET_ASSUMPTION, transformRow } from '../../src/engine/savings'
import { fixtureRecords, runAdapter, withIndex } from './helpers/otherFixtures'

const ROOT = join(__dirname, '..', '..')
const SNAPSHOT_FILE = '2026-10-29-aa992e3f.json'
const worked = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'worked-examples.json'), 'utf8')) as {
  snapshot: { file: string; date: string; sha256: string; commit: string }
}
const snapshot = PricingSnapshot.parse(JSON.parse(readFileSync(join(ROOT, 'public', 'pricing', SNAPSHOT_FILE), 'utf8')))
const meta: FrozenSnapshot = { file: SNAPSHOT_FILE, date: worked.snapshot.date, sha256: worked.snapshot.sha256, commit: worked.snapshot.commit }
const engine = createPricingEngine(snapshot, meta)

function writes(w: Partial<Record<CacheDuration, number>> = {}): NormalizedUsageRow['tokens']['cacheWrite'] {
  return { '5m': 0, '1h': 0, '30m': 0, '12h': 0, ...w }
}

let nextIndex = 0
function row(over: Omit<Partial<NormalizedUsageRow>, 'tokens'> & { tokens?: Partial<NormalizedUsageRow['tokens']> } = {}): AuditRow {
  const { tokens, ...rest } = over
  return engine.price({
    rowIndex: nextIndex++,
    timestamp: '2026-10-01T00:00:00.000Z',
    variant: 'B-json',
    provider: 'openai',
    modelLogged: 'gpt-6.1-sol',
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
  })
}

function routing(over: Partial<RoutingAssumptions> = {}): RoutingAssumptions {
  return {
    sourceModels: [],
    inputBands: [],
    targetModel: 'gpt-6.1-sol',
    eligibleShare: '1',
    outputLengthRatio: '1',
    tokenizerRatio: '1',
    retryFallbackRate: '0',
    routingOverheadTokens: 0,
    calibrationPassRate: null,
    ...over,
  }
}

function run(rows: readonly AuditRow[], over: Partial<Omit<ScenarioRequest, 'snapshot' | 'snapshotMeta'>> = {}): ScenarioResult {
  const s = createScenario({ snapshot, snapshotMeta: meta, baselineKey: null, routing: null, durationMap: DEFAULT_DURATION_MAP, ...over })
  // Feed in two batches, the way the worker does.
  s.add(rows.slice(0, 1))
  s.add(rows.slice(1))
  const r = s.result(5)
  expect(ScenarioResult.safeParse(r).success).toBe(true)
  return r
}

/** Same model, neutral assumptions: routing to the logged model and a baseline at the logged model. */
function neutral(rows: readonly AuditRow[], model: string): ScenarioResult {
  return run(rows, { baselineKey: model, routing: routing({ sourceModels: [model], targetModel: model }) })
}

function expectZero(r: ScenarioResult): void {
  expect(r.routing!.scenario.exactUsd).toBe(r.listOriginal.exactUsd)
  expect(r.routing!.savings).toEqual({ exactUsd: '0', displayUsd: '$0.000000' })
  expect(r.baseline!.difference).toEqual({ exactUsd: '0', displayUsd: '$0.000000' })
  expect(r.baseline!.value.exactUsd).toBe(r.listOriginal.exactUsd)
  expect(r.baseline!.rowsNotPriced).toBe(0)
}

describe('same model with neutral assumptions gives zero savings', () => {
  it('the b-openai-responses.json repro gives savings of exactly $0.000000', () => {
    const rows = withIndex(runAdapter('B-json', fixtureRecords('b-openai-responses.json', 'B-json'))).map((r) => engine.price(r))
    const r = neutral(rows, 'gpt-6.1-sol')
    expect(r.rowsRead).toBe(5)
    expect(r.routing!.eligibleRows).toBe(2)
    expect(r.routing!.savings.exactUsd).toBe('0')
    expect(r.routing!.savings.displayUsd).toBe('$0.000000')
    expect(r.routing!.scenario.exactUsd).toBe(r.listOriginal.exactUsd)
    // The long context row (300k input) is priced at the long context rates on both sides.
    const long = rows.find((x) => x.tokens.cacheRead === 100000)!
    expect(long.flags).toContain('long_context_applied')
    expect(transformRowCost(long, 'gpt-6.1-sol')).toBe(long.cost.estimateUsd)
  })

  it('OpenAI Responses rows with 30m and 12h writes', () => {
    const rows = [
      row({ tokens: { uncachedInput: 1000, cacheRead: 4000, cacheWrite: writes({ '30m': 3000, '12h': 4000 }), output: 500, reasoning: 0 } }),
      row({ tierStated: null, tokens: { uncachedInput: 12, cacheWrite: writes({ '12h': 99 }), output: 7 } }),
    ]
    const r = neutral(rows, 'gpt-6.1-sol')
    expect(r.listOriginal.exactUsd).toBe('0.035489')
    expectZero(r)
  })

  it('Anthropic rows with 5m and 1h writes', () => {
    const rows = [
      row({ variant: 'D-json', provider: 'anthropic', modelLogged: 'claude-sonnet-4-5-20250929', tokens: { uncachedInput: 2048, cacheRead: 1800, cacheWrite: writes({ '5m': 148, '1h': 100 }), output: 503 } }),
      row({ variant: 'D-json', provider: 'anthropic', modelLogged: 'claude-sonnet-4-5-20250929', tierStated: null, tokens: { uncachedInput: 5, cacheWrite: writes({ '1h': 4000 }), output: 1 } }),
    ]
    const r = neutral(rows, 'claude-sonnet-4-5-20250929')
    expect(r.rowsCompared).toBe(2)
    expectZero(r)
  })

  it('batch, flex and priority rows', () => {
    const rows = (['batch', 'flex', 'priority'] as const).map((tierStated) =>
      row({ tierStated, tokens: { uncachedInput: 3000, cacheRead: 2000, cacheWrite: writes({ '30m': 500, '12h': 700 }), output: 800, reasoning: 100 } }),
    )
    const anthropicBatch = row({ modelLogged: 'claude-sonnet-4-5-20250929', provider: 'anthropic', tierStated: 'batch', tokens: { uncachedInput: 3000, cacheWrite: writes({ '5m': 400 }), output: 50 } })
    for (const r of rows) expect(r.cost.appliedRates.every((a) => /_(batches|flex|priority)$/.test(a.rateKey))).toBe(true)
    expectZero(neutral(rows, 'gpt-6.1-sol'))
    expectZero(neutral([anthropicBatch], 'claude-sonnet-4-5-20250929'))
  })

  it('long context rows', () => {
    const rows = [
      row({ tokens: { uncachedInput: 280000, cacheRead: 10000, cacheWrite: writes({ '12h': 5000 }), output: 2000 } }),
      row({ tierStated: 'priority', tokens: { uncachedInput: 300000, output: 10 } }),
      row({ tokens: { uncachedInput: 200000, output: 10 }, excluded: { input_image: 80000 } }),
    ]
    for (const r of rows) expect(r.flags).toContain('long_context_applied')
    expectZero(neutral(rows, 'gpt-6.1-sol'))
  })

  it('Measured charge rows: the logged versus list difference has its own line and savings stay 0', () => {
    const rows = [
      row({
        variant: 'E-json',
        modelLogged: 'openai/gpt-4o',
        tierStated: null,
        reported: { amountUsd: '0.006', field: 'usage.cost', kind: 'charge' },
        tokens: { uncachedInput: 86, cacheRead: 1920, output: 300 },
      }),
      row({ variant: 'E-json', modelLogged: 'openai/gpt-4o', tierStated: null, tokens: { uncachedInput: 1000, output: 100 } }),
    ]
    expect(rows[0]!.cost.label.kind).toBe('Measured charge')
    const r = run(rows, { baselineKey: 'gpt-4o', routing: routing({ sourceModels: ['openai/gpt-4o'], targetModel: 'gpt-4o' }) })
    expect(r.loggedVersusList).toEqual({
      label: LOGGED_VERSUS_LIST_LABEL,
      rows: 1,
      logged: { exactUsd: '0.006', displayUsd: '$0.006000' },
      list: { exactUsd: '0.005615', displayUsd: '$0.005615' },
      difference: { exactUsd: '0.000385', displayUsd: '$0.000385' },
    })
    expect(r.loggedVersusList!.label).toBe('logged charges versus list price')
    // The list price of the charged row, not its charge, is on both sides of the comparison.
    expect(r.listOriginal.exactUsd).toBe('0.009115')
    expect(r.routing!.eligibleRows).toBe(2)
    expectZero(r)
    expect(r.assumptions).toContain('logged charges are compared with list price on their own line and are never counted as savings')
  })

  it('a share below one, retries of zero and a calibration pass rate of one change nothing on the same model', () => {
    const rows = [row({ tokens: { uncachedInput: 1234, cacheRead: 77, cacheWrite: writes({ '30m': 9 }), output: 55 } })]
    const r = run(rows, { routing: routing({ eligibleShare: '0.37', calibrationPassRate: '1' }) })
    expect(r.routing!.savings.exactUsd).toBe('0')
  })
})

/** Estimate of a row moved to a model with neutral ratios. */
function transformRowCost(r: AuditRow, key: string): string | null {
  const t = transformRow(r, key, { models: engine.models, tokenizerRatio: 1_000_000n, outputLengthRatio: 1_000_000n, overheadTokens: 0n, durationMap: DEFAULT_DURATION_MAP })
  return engine.price(t.row).cost.estimateUsd
}

describe('long context threshold per request after scaling', () => {
  it('a tokenizer ratio of 1.5 takes 110k and 190k to 165k and 285k; only the second uses the above 272k rates', () => {
    const small = row({ tokens: { uncachedInput: 110000, output: 1000 } })
    const large = row({ tokens: { uncachedInput: 190000, output: 1000 } })
    expect(small.cost.estimateUsd).toBe('0.23')
    expect(large.cost.estimateUsd).toBe('0.39')
    const opts = { models: engine.models, tokenizerRatio: 1_500_000n, outputLengthRatio: 1_000_000n, overheadTokens: 0n, durationMap: DEFAULT_DURATION_MAP }

    const a = engine.price(transformRow(small, 'gpt-6.1-sol', opts).row)
    expect(a.tokens.uncachedInput).toBe(165000)
    expect(a.tokens.output).toBe(1500)
    expect(a.cost.appliedRates.map((x) => x.rateKey)).toEqual(['input_cost_per_token', 'output_cost_per_token'])
    // 165,000 x 0.000002 + 1,500 x 0.00001
    expect(a.cost.estimateUsd).toBe('0.345')

    const b = engine.price(transformRow(large, 'gpt-6.1-sol', opts).row)
    expect(b.tokens.uncachedInput).toBe(285000)
    expect(b.cost.appliedRates.map((x) => x.rateKey)).toEqual(['input_cost_per_token_above_272k_tokens', 'output_cost_per_token_above_272k_tokens'])
    // 285,000 x 0.000004 + 1,500 x 0.000015
    expect(b.cost.estimateUsd).toBe('1.1625')

    const one = (x: AuditRow) => run([x], { routing: routing({ tokenizerRatio: '1.5' }) }).routing!.scenario.exactUsd
    expect(one(small)).toBe('0.345')
    expect(one(large)).toBe('1.1625')
    const both = run([small, large], { routing: routing({ tokenizerRatio: '1.5' }) })
    expect(both.listOriginal.exactUsd).toBe('0.62')
    expect(both.routing!.scenario.exactUsd).toBe('1.5075')
    expect(both.routing!.savings).toEqual({ exactUsd: '-0.8875', displayUsd: '-$0.887500' })
  })

  it('routing overhead can push a request over the threshold', () => {
    const r = row({ tokens: { uncachedInput: 271000, output: 0 } })
    const opts = { models: engine.models, tokenizerRatio: 1_000_000n, outputLengthRatio: 1_000_000n, overheadTokens: 2000n, durationMap: DEFAULT_DURATION_MAP }
    const t = engine.price(transformRow(r, 'gpt-6.1-sol', opts).row)
    expect(t.tokens.uncachedInput).toBe(273000)
    expect(t.flags).toContain('long_context_applied')
    expect(t.cost.estimateUsd).toBe('1.092')
  })
})

describe('time-bucket rows', () => {
  it('are counted and labelled uncertain when a model has long context keys', () => {
    const bucket = row({ variant: 'C-page', granularity: 'time_bucket', requests: 10, tokens: { uncachedInput: 400000, output: 1000 } })
    expect(bucket.flags).toContain('long_context_not_applied_bucket')
    const r = neutral([bucket, row({ tokens: { uncachedInput: 10, output: 1 } })], 'gpt-6.1-sol')
    expect(r.timeBucketRows).toBe(1)
    expect(r.longContextUncertain).toBe(true)
    expect(r.assumptions).toContain(TIME_BUCKET_ASSUMPTION)
    expect(TIME_BUCKET_ASSUMPTION).toBe('time-bucket rows have no request sizes: priced at base rates, long-context result uncertain')
    expectZero(r)
  })

  it('are not uncertain when neither the original nor the target model has long context keys', () => {
    const bucket = row({ variant: 'C-page', modelLogged: 'gpt-4o', granularity: 'time_bucket', requests: 10, tokens: { uncachedInput: 400000, output: 1000 } })
    const r = run([bucket], { routing: routing({ targetModel: 'gpt-4o-mini' }) })
    expect(r.timeBucketRows).toBe(1)
    expect(r.longContextUncertain).toBe(false)
    expect(r.assumptions).toContain(TIME_BUCKET_ASSUMPTION)
    // Routing to a model with long context keys makes it uncertain.
    expect(run([bucket], { routing: routing({ targetModel: 'gpt-6.1-sol' }) }).longContextUncertain).toBe(true)
  })

  it('routing overhead is added per request of the bucket', () => {
    const bucket = row({ variant: 'C-page', modelLogged: 'gpt-4o', granularity: 'time_bucket', requests: 10, tokens: { uncachedInput: 1000 } })
    const r = run([bucket], { routing: routing({ targetModel: 'gpt-4o-mini', routingOverheadTokens: 100 }) })
    // (1,000 + 100 x 10) x 0.00000015
    expect(r.routing!.scenario.exactUsd).toBe('0.0003')
  })
})

describe('cache-write durations across provider families', () => {
  const sonnet = () =>
    row({ variant: 'D-json', provider: 'anthropic', modelLogged: 'claude-sonnet-4-5-20250929', tokens: { uncachedInput: 1000, cacheWrite: writes({ '5m': 1000, '1h': 2000 }), output: 100 } })

  it('Anthropic durations follow the default map on an OpenAI-family target', () => {
    const c = sonnet()
    expect(c.cost.estimateUsd).toBe('0.02025')
    const t = transformRow(c, 'gpt-6.1-sol', { models: engine.models, tokenizerRatio: 1_000_000n, outputLengthRatio: 1_000_000n, overheadTokens: 0n, durationMap: DEFAULT_DURATION_MAP })
    expect(t.durationsMapped).toBe(true)
    expect(t.row.tokens.cacheWrite).toEqual(writes({ '30m': 1000, '12h': 2000 }))
    const r = run([c], { routing: routing() })
    // 1,000 x 0.000002 + 1,000 x 0.0000025 + 2,000 x 0.000005 + 100 x 0.00001
    expect(r.routing!.scenario.exactUsd).toBe('0.0155')
    expect(r.routing!.savings.exactUsd).toBe('0.00475')
    expect(r.routing!.notes.join(' ')).toContain('cache-write durations follow the duration map (user-supplied assumption)')
  })

  it('a user-supplied map is used as given', () => {
    const map = { '5m': '12h', '1h': '12h', '30m': '5m', '12h': '1h' } as const
    const r = run([sonnet()], { routing: routing(), durationMap: map })
    // 1,000 x 0.000002 + 3,000 x 0.000005 + 100 x 0.00001
    expect(r.routing!.scenario.exactUsd).toBe('0.018')
    expect(r.durationMap).toEqual(map)
    expect(r.assumptions.join('\n')).toContain('5m to 12h, 1h to 12h, 30m to 5m, 12h to 1h: user-supplied assumption')
  })

  it('OpenAI durations map to Anthropic durations, and the baseline uses the map too', () => {
    const o = row({ tokens: { uncachedInput: 100, cacheWrite: writes({ '30m': 1000, '12h': 10 }) } })
    const r = run([o], { baselineKey: 'claude-sonnet-4-5-20250929' })
    // 100 x 0.000003 + 1,000 x 0.00000375 + 10 x 0.000006
    expect(r.baseline!.value.exactUsd).toBe('0.00411')
    expect(r.baseline!.notes.join(' ')).toContain('duration map')
  })

  it('the same family keeps durations', () => {
    const t = transformRow(sonnet(), 'claude-haiku-4-5', { models: engine.models, tokenizerRatio: 1_000_000n, outputLengthRatio: 1_000_000n, overheadTokens: 0n, durationMap: DEFAULT_DURATION_MAP })
    expect(t.durationsMapped).toBe(false)
    expect(t.row.tokens.cacheWrite).toEqual(writes({ '5m': 1000, '1h': 2000 }))
  })
})

describe('tier on the target', () => {
  const flex = () => row({ tierStated: 'flex', tokens: { uncachedInput: 1000, output: 100 } })

  it('is kept when the target has input and output rates for it', () => {
    const r = run([flex()], { routing: routing({ targetModel: 'gpt-5' }) })
    // 1,000 x 0.000000625 + 100 x 0.000005
    expect(r.routing!.scenario.exactUsd).toBe('0.001125')
    expect(r.routing!.notes.join(' ')).not.toContain('tier assumed')
  })

  it('is assumed standard with a note when the target has no rates for it', () => {
    const t = transformRow(flex(), 'claude-sonnet-4-5-20250929', { models: engine.models, tokenizerRatio: 1_000_000n, outputLengthRatio: 1_000_000n, overheadTokens: 0n, durationMap: DEFAULT_DURATION_MAP })
    expect(t.tierDropped).toBe(true)
    expect(t.row.tierStated).toBeNull()
    expect(engine.price(t.row).flags).toContain('tier_assumed')
    const r = run([flex()], { routing: routing({ targetModel: 'claude-sonnet-4-5-20250929' }) })
    // 1,000 x 0.000003 + 100 x 0.000015
    expect(r.routing!.scenario.exactUsd).toBe('0.0045')
    expect(r.routing!.notes).toContain('1 row stated a tier that claude-sonnet-4-5-20250929 has no input and output rates for, so standard is assumed (tier assumed)')
  })
})

describe('target without a rate', () => {
  it('keeps the row at its original list price, counts it and names the reason', () => {
    const withWrites = row({ variant: 'D-json', provider: 'anthropic', modelLogged: 'claude-sonnet-4-5-20250929', tokens: { uncachedInput: 1000, cacheWrite: writes({ '5m': 1000 }), output: 100 } })
    const plain = row({ variant: 'D-json', provider: 'anthropic', modelLogged: 'claude-sonnet-4-5-20250929', tokens: { uncachedInput: 1000, output: 100 } })
    const r = run([withWrites, plain], { routing: routing({ targetModel: 'gemini-2.5-flash' }), baselineKey: 'gemini-2.5-flash' })
    expect(r.listOriginal.exactUsd).toBe('0.01275')
    expect(r.routing!.eligibleRows).toBe(2)
    expect(r.routing!.targetRateFallbackRows).toBe(1)
    // 0.00825 kept + 1,000 x 0.0000003 + 100 x 0.0000025
    expect(r.routing!.scenario.exactUsd).toBe('0.0088')
    expect(r.routing!.savings.exactUsd).toBe('0.00395')
    expect(r.routing!.notes[0]).toBe(
      '1 eligible rows kept their original cost because the target has no rate for them: cache writes on provider "vertex_ai-language-models" have no documented duration mapping (1 row)',
    )
    // The baseline leaves the row out of both of its sides.
    expect(r.baseline).toMatchObject({ rowsPriced: 1, rowsNotPriced: 1 })
    expect(r.baseline!.comparedOriginal.exactUsd).toBe('0.0045')
    expect(r.baseline!.value.exactUsd).toBe('0.00055')
    expect(r.baseline!.difference.exactUsd).toBe('-0.00395')
  })
})

describe('rows left out', () => {
  it('counts each reason and leaves the rows out of both sides', () => {
    const rows = [
      row({ tokens: { uncachedInput: 100, output: 10 } }),
      row({ counted: false, tokens: { uncachedInput: 100, output: 10 } }),
      row({ flags: ['malformed'], tokens: { uncachedInput: 100 } }),
      row({ unresolvedReason: 'cache tokens exceed input tokens', tokens: { uncachedInput: 100 } }),
      row({ modelLogged: 'unlisted-model-x', tokens: { uncachedInput: 100 } }),
      row({ modelLogged: 'unlisted-model-x', reported: { amountUsd: '0.5', field: 'usage.cost', kind: 'charge' }, tokens: { uncachedInput: 100 } }),
      row({ notMeasured: ['output'], reported: { amountUsd: '0.5', field: 'usage.cost', kind: 'charge' }, tokens: { uncachedInput: 100 } }),
      row({ notMeasured: ['output'], tokens: { uncachedInput: 100 } }),
    ]
    expect(rows[6]!.flags).toContain('estimate_incomplete')
    expect(rows[6]!.cost.label.kind).toBe('Measured charge')
    expect(rows[7]!.cost.label.kind).toBe('Unresolved')
    const r = neutral(rows, 'gpt-6.1-sol')
    expect(r.rowsRead).toBe(8)
    expect(r.rowsCompared).toBe(1)
    expect(r.rowsLeftOut).toEqual([
      { reason: LEFT_OUT.notCounted, rows: 1 },
      { reason: LEFT_OUT.malformed, rows: 1 },
      { reason: LEFT_OUT.unresolved, rows: 2 },
      { reason: LEFT_OUT.noListPrice, rows: 2 },
      { reason: LEFT_OUT.estimateIncomplete, rows: 1 },
    ])
    expect(r.rowsLeftOut.map((x) => x.reason)).toEqual(['not counted (aggregate span)', 'malformed', 'Unresolved', 'no list price', 'token estimate incomplete'])
    expect(r.listOriginal.exactUsd).toBe('0.0003')
    // The Measured charge rows left out do not appear on the logged versus list line either.
    expect(r.loggedVersusList).toBeNull()
    expectZero(r)
  })
})

describe('result shape', () => {
  it('is Estimated, unverified and lists every user-supplied value', () => {
    const r = run([row({ tokens: { uncachedInput: 100, output: 10 } })], {
      baselineKey: 'gpt-4o',
      routing: routing({ targetModel: 'gpt-4o-mini', eligibleShare: '0.5', calibrationPassRate: '0.9', routingOverheadTokens: 3 }),
    })
    expect(r.label.kind).toBe('Estimated')
    expect(r.quality).toBe('unverified')
    expect(r.baseline!.label).toBe('Modelled: the baseline never ran')
    expect(r.snapshot).toEqual(meta)
    expect(r.elapsedMs).toBe(5)
    const text = r.assumptions.join('\n')
    for (const v of ['baseline model gpt-4o', 'target model gpt-4o-mini', 'eligible share 0.5', 'output length ratio 1', 'tokenizer ratio 1', 'retry and fallback rate 0', 'routing overhead 3 tokens', 'calibration pass rate 0.9', 'cache-write duration map']) {
      expect(r.assumptions.find((l) => l.startsWith(v))).toContain('user-supplied assumption')
    }
    expect(text).toContain('rounded half up to whole tokens')
    expect(text).toContain('a stated tier is kept when the target model has input and output rates for it')
  })

  it('rejects models that are not in the snapshot', () => {
    expect(() => createScenario({ snapshot, snapshotMeta: meta, baselineKey: 'unlisted-model-x', routing: null, durationMap: DEFAULT_DURATION_MAP })).toThrow('not in the snapshot')
    expect(() => createScenario({ snapshot, snapshotMeta: meta, baselineKey: null, routing: routing({ targetModel: 'unlisted-model-x' }), durationMap: DEFAULT_DURATION_MAP })).toThrow('not in the snapshot')
  })
})
