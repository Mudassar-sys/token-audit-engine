import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Aggregator } from '../../src/engine/aggregate'
import { litellmAdapter, LITELLM_INCLUSION_FACT, type LiteLlmInclusion } from '../../src/engine/adapters/litellm'
import { openaiChatAdapter } from '../../src/engine/adapters/openaiChat'
import { openaiResponsesAdapter } from '../../src/engine/adapters/openaiResponses'
import { openrouterAdapter } from '../../src/engine/adapters/openrouter'
import type { Adapter, AdapterRow, RawRecord } from '../../src/engine/adapters/types'
import {
  AuditRow,
  PricingSnapshot,
  type FrozenSnapshot,
  type NormalizedUsageRow,
  type ReportedAmount,
  type Tier,
  type VariantId,
} from '../../src/engine/contracts'
import { femtoToExactUsd, usdToFemto } from '../../src/engine/money'
import { createPricingEngine } from '../../src/engine/pricing'

const ROOT = join(__dirname, '..', '..')
const worked = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'worked-examples.json'), 'utf8')) as {
  snapshot: { file: string; date: string; sha256: string; commit: string }
}
const snapshot = PricingSnapshot.parse(JSON.parse(readFileSync(join(ROOT, 'public', 'pricing', worked.snapshot.file), 'utf8')))
const meta: FrozenSnapshot = { file: worked.snapshot.file, date: worked.snapshot.date, sha256: worked.snapshot.sha256, commit: worked.snapshot.commit }
const engine = createPricingEngine(snapshot, meta)

const MODELS = [
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-6.1-sol',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5',
  'codestral/codestral-latest',
  'gemini-2.5-flash',
  'openai/gpt-4o',
  'acme-unlisted-model-x',
]

const tokens = fc.nat({ max: 600_000 })
/** Non-negative USD text with at most 15 decimals, built from integers. */
const usdText = fc.bigInt({ min: 0n, max: 10n ** 16n }).map((f) => femtoToExactUsd(f))

const reportedArb: fc.Arbitrary<ReportedAmount | null> = fc.oneof(
  fc.constant(null),
  fc.record({ amountUsd: usdText, field: fc.constant('usage.cost'), kind: fc.constant('charge' as const) }),
  fc.record({ amountUsd: fc.oneof(usdText, fc.constant('0')), field: fc.constant('spend'), kind: fc.constant('gateway_estimate' as const) }),
  fc.record({ amountUsd: fc.constant('-0.5'), field: fc.constant('usage.cost'), kind: fc.constant('charge' as const) }),
)

const rowArb: fc.Arbitrary<NormalizedUsageRow> = fc
  .record({
    model: fc.option(fc.constantFrom(...MODELS), { nil: null }),
    tier: fc.option(fc.constantFrom<Tier>('standard', 'batch', 'flex', 'priority', 'ultrafast'), { nil: null }),
    bucket: fc.boolean(),
    uncached: tokens,
    read: tokens,
    w5: fc.nat({ max: 50_000 }),
    w1h: fc.nat({ max: 50_000 }),
    w30: fc.nat({ max: 50_000 }),
    w12: fc.nat({ max: 50_000 }),
    output: tokens,
    reasoning: fc.option(tokens, { nil: null }),
    reported: reportedArb,
    unresolved: fc.option(fc.constant('needs review'), { nil: null, freq: 8 }),
    requests: fc.integer({ min: 1, max: 50 }),
  })
  .map((g) => ({
    rowIndex: 0,
    timestamp: '2026-10-01T00:00:00.000Z',
    variant: 'A-json' as VariantId,
    provider: 'openai',
    modelLogged: g.model,
    tierStated: g.tier,
    granularity: g.bucket ? ('time_bucket' as const) : ('request' as const),
    tokens: {
      uncachedInput: g.uncached,
      cacheRead: g.read,
      cacheWrite: { '5m': g.w5, '1h': g.w1h, '30m': g.w30, '12h': g.w12 },
      output: g.output,
      reasoning: g.reasoning === null ? null : Math.min(g.reasoning, g.output),
    },
    notMeasured: [],
    excluded: {},
    reported: g.reported,
    raw: {},
    mapping: [],
    flags: [],
    unresolvedReason: g.unresolved,
    counted: true,
    requests: g.bucket ? g.requests : 1,
  }))

describe('pricing properties', () => {
  it('cost is never negative', () => {
    fc.assert(
      fc.property(rowArb, (r) => {
        const out = engine.price(r)
        if (out.cost.valueUsd !== null) expect(usdToFemto(out.cost.valueUsd) >= 0n).toBe(true)
        if (out.cost.estimateUsd !== null) expect(usdToFemto(out.cost.estimateUsd) >= 0n).toBe(true)
        for (const a of out.cost.appliedRates) expect(usdToFemto(a.costUsd) >= 0n).toBe(true)
        if (out.cost.valueUsd === null) expect(['Not priced', 'Unresolved']).toContain(out.cost.label.kind)
      }),
      { numRuns: 400 },
    )
  })

  it('every priced row is contract-valid', () => {
    fc.assert(
      fc.property(rowArb, (r) => {
        expect(AuditRow.safeParse(engine.price(r)).success).toBe(true)
      }),
      { numRuns: 100 },
    )
  })

  it('the sum of row values equals the total exactly', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 0, maxLength: 60 }), (rows) => {
        const agg = new Aggregator()
        let sum = 0n
        rows.forEach((r, i) => {
          const out = engine.price({ ...r, rowIndex: i })
          agg.add(out)
          if (out.cost.valueUsd !== null) sum += usdToFemto(out.cost.valueUsd)
        })
        expect(agg.summary().totals.value.exactUsd).toBe(femtoToExactUsd(sum))
      }),
      { numRuns: 150 },
    )
  })
})

/** Sources whose input total already includes cached tokens. */
interface Case {
  variant: VariantId
  adapter: Adapter
  record: (g: Gen) => unknown
  promptOf: (g: Gen) => number
}

interface Gen {
  prompt: number
  read: number
  write: number
  withWrite: boolean
  output: number
  reasoning: number
}

const genArb: fc.Arbitrary<Gen> = fc.record({
  prompt: fc.nat({ max: 400_000 }),
  read: fc.nat({ max: 400_000 }),
  write: fc.nat({ max: 50_000 }),
  withWrite: fc.boolean(),
  output: fc.nat({ max: 20_000 }),
  reasoning: fc.nat({ max: 20_000 }),
})

const CASES: Case[] = [
  {
    variant: 'A-json',
    adapter: openaiChatAdapter,
    record: (g) => ({
      id: 'chatcmpl-prop',
      object: 'chat.completion',
      created: 1761700000,
      model: 'gpt-4o',
      service_tier: 'default',
      usage: {
        prompt_tokens: g.prompt,
        completion_tokens: g.output,
        total_tokens: g.prompt + g.output,
        prompt_tokens_details: g.withWrite ? { cached_tokens: g.read, cache_write_tokens: g.write } : { cached_tokens: g.read },
        completion_tokens_details: { reasoning_tokens: Math.min(g.reasoning, g.output) },
      },
    }),
    promptOf: (g) => g.prompt,
  },
  {
    variant: 'B-json',
    adapter: openaiResponsesAdapter,
    record: (g) => ({
      id: 'resp_prop',
      object: 'response',
      created_at: 1761700000,
      model: 'gpt-6.1-sol',
      service_tier: 'default',
      usage: {
        input_tokens: g.prompt,
        input_tokens_details: g.withWrite ? { cached_tokens: g.read, cache_write_tokens: g.write } : { cached_tokens: g.read },
        output_tokens: g.output,
        output_tokens_details: { reasoning_tokens: Math.min(g.reasoning, g.output) },
        total_tokens: g.prompt + g.output,
      },
    }),
    promptOf: (g) => g.prompt,
  },
  {
    variant: 'E-json',
    adapter: openrouterAdapter,
    record: (g) => ({
      id: 'gen-prop',
      object: 'chat.completion',
      created: 1761700000,
      model: 'openai/gpt-4o',
      usage: {
        prompt_tokens: g.prompt,
        completion_tokens: g.output,
        total_tokens: g.prompt + g.output,
        cost: 0.001,
        prompt_tokens_details: g.withWrite ? { cached_tokens: g.read, cache_write_tokens: g.write } : { cached_tokens: g.read },
        completion_tokens_details: { reasoning_tokens: Math.min(g.reasoning, g.output) },
      },
    }),
    promptOf: (g) => g.prompt,
  },
]

function writeSum(r: AdapterRow): number {
  const w = r.tokens.cacheWrite
  return w['5m'] + w['1h'] + w['30m'] + w['12h']
}

function checkRow(r: AdapterRow, prompt: number): void {
  const priced = engine.price({ ...r, rowIndex: 0 })
  if (r.unresolvedReason !== null || r.flags.includes('malformed')) {
    expect(priced.cost.valueUsd === null || priced.cost.label.kind !== 'Estimated').toBe(true)
    expect(priced.cost.label.kind).toBe('Unresolved')
    return
  }
  expect(r.tokens.uncachedInput).toBeGreaterThanOrEqual(0)
  expect(r.tokens.cacheRead + writeSum(r)).toBeLessThanOrEqual(prompt)
  expect(r.tokens.uncachedInput + r.tokens.cacheRead + writeSum(r)).toBeLessThanOrEqual(prompt)
}

describe('normalization properties: cached never exceeds input unless the row is Unresolved', () => {
  for (const c of CASES) {
    it(`${c.variant}`, () => {
      fc.assert(
        fc.property(genArb, (g) => {
          const run = c.adapter.begin({ variant: c.variant, mapping: null, fileFacts: {} })
          const rows = [...run.push({ kind: 'json', value: c.record(g), line: 1 }), ...run.finish()]
          expect(rows.length).toBeGreaterThan(0)
          for (const r of rows) checkRow(r, c.promptOf(g))
        }),
        { numRuns: 300 },
      )
    })
  }

  it('F-json in a file decided as included', () => {
    fc.assert(
      fc.property(fc.array(genArb, { minLength: 1, maxLength: 30 }), fc.nat(), (gens, cut) => {
        const records: RawRecord[] = gens.map((g, i) => ({
          kind: 'json',
          line: null,
          value: {
            request_id: `req-prop-${i}`,
            call_type: 'acompletion',
            spend: 0.001,
            prompt_tokens: g.prompt,
            completion_tokens: g.output,
            total_tokens: g.prompt + g.output,
            startTime: '2026-10-01T00:00:00Z',
            model: 'gpt-4o',
            custom_llm_provider: 'openai',
            metadata: {
              additional_usage_values: g.withWrite
                ? { cache_read_input_tokens: g.read, cache_creation_input_tokens: g.write }
                : { cache_read_input_tokens: g.read },
            },
          },
        }))
        // The scan sees only a prefix, so later rows can contradict the file decision.
        const facts = litellmAdapter.scanFileFacts!(records.slice(0, 1 + (cut % records.length)))
        const inclusion = facts[LITELLM_INCLUSION_FACT] as LiteLlmInclusion
        fc.pre(inclusion.mode === 'included')
        const run = litellmAdapter.begin({ variant: 'F-json', mapping: null, fileFacts: facts })
        records.forEach((rec, i) => {
          for (const r of run.push(rec)) checkRow(r, gens[i]!.prompt)
        })
      }),
      { numRuns: 300 },
    )
  })
})
