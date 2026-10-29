import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Aggregator } from '../../src/engine/aggregate'
import { AuditRow, CustomCsvMapping, PricingSnapshot, type FrozenSnapshot, type VariantId } from '../../src/engine/contracts'
import type { AdapterRow, RawRecord } from '../../src/engine/adapters/types'
import { detectFromSample } from '../../src/engine/detect'
import { usdToFemto } from '../../src/engine/money'
import { runImport } from '../../src/engine/pipeline'
import { createPricingEngine } from '../../src/engine/pricing'
import { FIXTURES, fixtureRecords, runAdapter } from './helpers/otherFixtures'

/**
 * Absent billed usage: a source that leaves out its input or output total must never be read as 0.
 * Every adapter lists the absent class in notMeasured (an explicit 0 stays measured), and pricing then
 * keeps a Measured charge, or marks the row Unresolved with the class named, and the summary is partial.
 */

const ROOT = process.cwd()
const worked = JSON.parse(readFileSync(join(FIXTURES, 'worked-examples.json'), 'utf8')) as {
  snapshot: FrozenSnapshot & { sourceUrl: string }
}
const snapshot = PricingSnapshot.parse(JSON.parse(readFileSync(join(ROOT, 'public', 'pricing', worked.snapshot.file), 'utf8')))
const meta = worked.snapshot
const engine = createPricingEngine(snapshot, meta)

const OUTPUT_MISSING = 'output tokens missing, cost would be understated'
const INPUT_MISSING = 'input tokens missing, cost would be understated'
const BOTH_MISSING = 'input and output tokens missing, cost would be understated'
const SUBTOTAL_REASON = 'subtotal of the classes present; not included in cost totals'

/** 1,000 input tokens at the gpt-4o list rate of $0.0000025. */
const GPT4O_INPUT_1000 = usdToFemto('0.0025')
/** 1,000 input tokens at the claude-sonnet-4-5 list rate of $0.000003. */
const SONNET_INPUT_1000 = usdToFemto('0.003')
/** 1,000 input tokens at the text-embedding-3-small list rate of $0.00000002. */
const EMBED_INPUT_1000 = usdToFemto('0.00002')

const json = (value: unknown): RawRecord => ({ kind: 'json', value, line: 1 })
const csv = (row: Record<string, string>): RawRecord => ({ kind: 'csv', row, line: 2 })

function rowsOf(variant: VariantId, records: RawRecord[], mapping: CustomCsvMapping | null = null): AdapterRow[] {
  return runAdapter(variant, records, mapping)
}

function oneRow(variant: VariantId, record: RawRecord, mapping: CustomCsvMapping | null = null): AdapterRow {
  const rows = rowsOf(variant, [record], mapping)
  expect(rows).toHaveLength(1)
  return rows[0]!
}

function price(row: AdapterRow, rowIndex = 0): AuditRow {
  const out = engine.price({ ...row, rowIndex })
  expect(() => AuditRow.parse(out)).not.toThrow()
  return out
}

const femto = (usd: string | null) => (usd === null ? null : usdToFemto(usd))

/** No charge in the row: Unresolved with the exact reason, the present classes shown as a subtotal. */
function expectUnresolvedMissing(row: AuditRow, reason: string, subtotal: bigint | null) {
  expect(row.cost.valueUsd).toBeNull()
  expect(row.cost.label).toEqual({ kind: 'Unresolved', reason })
  expect(row.flags).toContain('billed_class_missing')
  expect(row.flags).not.toContain('estimate_incomplete')
  if (subtotal !== null) {
    expect(femto(row.cost.estimateUsd)).toBe(subtotal)
    expect(row.cost.estimateLabel).toEqual({ kind: 'Estimated', reason: SUBTOTAL_REASON })
  }
}

/** A Measured charge in the row: the charge is the value, the token estimate is labelled incomplete. */
function expectChargeKept(row: AuditRow, charge: string, subtotal: bigint, missing: string) {
  expect(femto(row.cost.valueUsd)).toBe(usdToFemto(charge))
  expect(row.cost.label.kind).toBe('Measured charge')
  expect(row.flags).toContain('billed_class_missing')
  expect(row.flags).toContain('estimate_incomplete')
  expect(femto(row.cost.estimateUsd)).toBe(subtotal)
  expect(row.cost.estimateLabel.kind).toBe('Estimated')
  expect(row.cost.estimateLabel.reason.startsWith(`incomplete: ${missing} tokens missing`)).toBe(true)
}

/** Every billed class present: an ordinary estimate, no missing-class flags. */
function expectPriced(row: AuditRow, value: bigint) {
  expect(femto(row.cost.valueUsd)).toBe(value)
  expect(row.cost.label.kind).toBe('Estimated')
  expect(row.flags).not.toContain('billed_class_missing')
  expect(row.flags).not.toContain('estimate_incomplete')
}

// ---------------------------------------------------------------------------
// Record builders, one per source.

const chat = (usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  json({ id: 'chatcmpl-au-1', object: 'chat.completion', created: 1792800000, model: 'gpt-4o', usage, service_tier: 'default', ...extra })

const response = (usage: Record<string, unknown>) =>
  json({ id: 'resp-au-1', object: 'response', created_at: 1792800000, model: 'gpt-4o', status: 'completed', usage })

const usageBucket = (result: Record<string, unknown>) =>
  json({
    object: 'bucket',
    start_time: 1792800000,
    end_time: 1792886400,
    results: [{ object: 'organization.usage.completions.result', num_model_requests: 1, model: 'gpt-4o', ...result }],
  })

const message = (usage: Record<string, unknown>) =>
  json({ id: 'msg-au-1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', usage })

const routed = (usage: Record<string, unknown>) =>
  json({ id: 'gen-au-1', object: 'chat.completion', created: 1792800000, model: 'openai/gpt-4o', usage })

const spendLog = (cells: Record<string, string>) =>
  csv({
    request_id: 'req-au-1',
    call_type: 'acompletion',
    api_key: 'hashed-key-7f3a',
    spend: '0.0025',
    total_tokens: '1000',
    prompt_tokens: '1000',
    completion_tokens: '0',
    startTime: '2026-10-01 00:00:00',
    endTime: '2026-10-01 00:00:01',
    model: 'gpt-4o',
    custom_llm_provider: 'openai',
    metadata: '{}',
    ...cells,
  })

type Attr = [string, string | number]
const span = (attrs: Attr[]) =>
  json({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc-7f3a' } }] },
        scopeSpans: [
          {
            scope: { name: 'genai' },
            spans: [
              {
                traceId: '0af7651916cd43dd8448eb211c80319c',
                spanId: 'b7ad6b7169203331',
                name: 'genai call',
                startTimeUnixNano: '1792800000000000000',
                attributes: attrs.map(([key, v]) => ({
                  key,
                  value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v },
                })),
              },
            ],
          },
        ],
      },
    ],
  })

const H_MAPPING = (over: Partial<CustomCsvMapping> = {}): CustomCsvMapping =>
  CustomCsvMapping.parse({
    timestamp: null,
    provider: 'vendor',
    model: 'model_name',
    inputTokens: 'input_tok',
    inputIncludesCached: false,
    cacheRead: null,
    cacheWrite: null,
    cacheWriteDuration: null,
    outputTokens: 'output_tok',
    reasoningTokens: null,
    tier: null,
    reportedCharge: null,
    ...over,
  })

// ---------------------------------------------------------------------------

describe('A: OpenAI Chat Completions', () => {
  it('absent completion_tokens is Not measured; an explicit 0 is measured', () => {
    const absent = oneRow('A-jsonl', chat({ prompt_tokens: 1000 }))
    expect(absent.notMeasured).toContain('output')
    expect(absent.mapping).toContain('output = not measured (usage.completion_tokens absent)')
    const zero = oneRow('A-jsonl', chat({ prompt_tokens: 1000, completion_tokens: 0 }))
    expect(zero.notMeasured).not.toContain('output')
    expect(zero.tokens.output).toBe(0)
    const noInput = oneRow('A-jsonl', chat({ completion_tokens: 50 }))
    expect(noInput.notMeasured).toContain('uncachedInput')
  })

  it('priced: no charge => Unresolved with the exact reason; explicit 0 => a valid estimate', () => {
    expectUnresolvedMissing(price(oneRow('A-jsonl', chat({ prompt_tokens: 1000 }))), OUTPUT_MISSING, GPT4O_INPUT_1000)
    expectPriced(price(oneRow('A-jsonl', chat({ prompt_tokens: 1000, completion_tokens: 0 }))), GPT4O_INPUT_1000)
    expectUnresolvedMissing(price(oneRow('A-jsonl', chat({ completion_tokens: 0 }))), INPUT_MISSING, 0n)
  })

  it('an absent cache class is not billed-missing: the row prices normally', () => {
    const row = oneRow('A-jsonl', chat({ prompt_tokens: 1000, completion_tokens: 0 }))
    expect(row.notMeasured).toContain('cacheWrite')
    expectPriced(price(row), GPT4O_INPUT_1000)
  })

  it('a row the adapter already left Unresolved keeps its own reason', () => {
    const row = oneRow('A-jsonl', chat({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } }))
    expect(row.unresolvedReason).toBe('cache and modality tokens exceed usage.prompt_tokens')
    const priced = price(row)
    expect(priced.cost.label).toEqual({ kind: 'Unresolved', reason: 'cache and modality tokens exceed usage.prompt_tokens' })
    expect(priced.flags).not.toContain('billed_class_missing')
  })

  it('a malformed row is not relabelled', () => {
    const row = oneRow('A-jsonl', chat({ prompt_tokens: 'x' }))
    const priced = price(row)
    expect(priced.flags).toContain('malformed')
    expect(priced.flags).not.toContain('billed_class_missing')
    expect(priced.cost.label.kind).toBe('Unresolved')
    expect(priced.cost.label.reason).not.toBe(OUTPUT_MISSING)
  })
})

describe('B: OpenAI Responses', () => {
  it('absent vs explicit 0, both directions', () => {
    expect(oneRow('B-jsonl', response({ input_tokens: 1000 })).notMeasured).toContain('output')
    expect(oneRow('B-jsonl', response({ input_tokens: 1000, output_tokens: 0 })).notMeasured).not.toContain('output')
    expect(oneRow('B-jsonl', response({ output_tokens: 10 })).notMeasured).toContain('uncachedInput')
    expect(oneRow('B-jsonl', response({ input_tokens: 0, output_tokens: 10 })).notMeasured).not.toContain('uncachedInput')
  })

  it('priced', () => {
    expectUnresolvedMissing(price(oneRow('B-jsonl', response({ input_tokens: 1000 }))), OUTPUT_MISSING, GPT4O_INPUT_1000)
    expectPriced(price(oneRow('B-jsonl', response({ input_tokens: 1000, output_tokens: 0 }))), GPT4O_INPUT_1000)
    expectUnresolvedMissing(price(oneRow('B-jsonl', response({ output_tokens: 0 }))), INPUT_MISSING, 0n)
  })
})

describe('C: OpenAI Usage API page', () => {
  it('absent output_tokens is Not measured; an explicit 0 is measured', () => {
    const absent = oneRow('C-page', usageBucket({ input_tokens: 1000 }))
    expect(absent.granularity).toBe('time_bucket')
    expect(absent.notMeasured).toContain('output')
    expect(oneRow('C-page', usageBucket({ input_tokens: 1000, output_tokens: 0 })).notMeasured).not.toContain('output')
    expect(oneRow('C-page', usageBucket({ output_tokens: 10 })).notMeasured).toContain('uncachedInput')
  })

  it('priced', () => {
    expectUnresolvedMissing(price(oneRow('C-page', usageBucket({ input_tokens: 1000 }))), OUTPUT_MISSING, GPT4O_INPUT_1000)
    expectPriced(price(oneRow('C-page', usageBucket({ input_tokens: 1000, output_tokens: 0 }))), GPT4O_INPUT_1000)
  })
})

describe('D: Anthropic Messages', () => {
  it('absent vs explicit 0', () => {
    const absent = oneRow('D-jsonl', message({ input_tokens: 1000 }))
    expect(absent.notMeasured).toContain('output')
    expect(absent.mapping).toContain('output = not measured (usage.output_tokens absent)')
    expect(oneRow('D-jsonl', message({ input_tokens: 1000, output_tokens: 0 })).notMeasured).not.toContain('output')
    const neither = oneRow('D-jsonl', message({}))
    expect(neither.flags).not.toContain('malformed')
    expect(neither.notMeasured).toEqual(expect.arrayContaining(['uncachedInput', 'output']))
  })

  it('priced, including both classes missing', () => {
    expectUnresolvedMissing(price(oneRow('D-jsonl', message({ input_tokens: 1000 }))), OUTPUT_MISSING, SONNET_INPUT_1000)
    expectPriced(price(oneRow('D-jsonl', message({ input_tokens: 1000, output_tokens: 0 }))), SONNET_INPUT_1000)
    expectUnresolvedMissing(price(oneRow('D-jsonl', message({}))), BOTH_MISSING, null)
  })
})

describe('E: OpenRouter', () => {
  it('absent vs explicit 0', () => {
    expect(oneRow('E-jsonl', routed({ prompt_tokens: 1000, cost: 0.0031 })).notMeasured).toContain('output')
    expect(oneRow('E-jsonl', routed({ prompt_tokens: 1000, completion_tokens: 0, cost: 0.0031 })).notMeasured).not.toContain('output')
  })

  it('a usage.cost charge is kept when output is missing; the estimate is labelled incomplete', () => {
    expectChargeKept(price(oneRow('E-jsonl', routed({ prompt_tokens: 1000, cost: 0.0031, is_byok: false }))), '0.0031', GPT4O_INPUT_1000, 'output')
  })

  it('a charge of 0 is still a charge and is kept', () => {
    expectChargeKept(price(oneRow('E-jsonl', routed({ prompt_tokens: 1000, cost: 0 }))), '0', GPT4O_INPUT_1000, 'output')
  })

  it('no charge => Unresolved with the exact reason', () => {
    expectUnresolvedMissing(price(oneRow('E-jsonl', routed({ prompt_tokens: 1000 }))), OUTPUT_MISSING, GPT4O_INPUT_1000)
  })

  it('every class present with a charge: Measured charge without the missing-class flags', () => {
    const row = price(oneRow('E-jsonl', routed({ prompt_tokens: 1000, completion_tokens: 0, cost: 0.0025 })))
    expect(row.cost.label.kind).toBe('Measured charge')
    expect(row.flags).not.toContain('billed_class_missing')
    expect(row.flags).not.toContain('estimate_incomplete')
  })
})

describe('F: LiteLLM spend logs', () => {
  it('empty or absent completion_tokens is Not measured; "0" is measured', () => {
    const empty = oneRow('F-csv', spendLog({ completion_tokens: '' }))
    expect(empty.notMeasured).toContain('output')
    expect(empty.mapping).toContain('output = not measured (completion_tokens empty)')
    const rest = { ...(spendLog({}) as { row: Record<string, string> }).row }
    delete rest.completion_tokens
    const absent = oneRow('F-csv', csv(rest))
    expect(absent.notMeasured).toContain('output')
    expect(absent.mapping).toContain('output = not measured (completion_tokens absent)')
    expect(oneRow('F-csv', spendLog({})).notMeasured).not.toContain('output')
    expect(oneRow('F-csv', spendLog({ prompt_tokens: '' })).notMeasured).toContain('uncachedInput')
  })

  it('a gateway spend does not keep the row: Unresolved with the exact reason, the spend still shown', () => {
    const row = price(oneRow('F-csv', spendLog({ completion_tokens: '' })))
    expectUnresolvedMissing(row, OUTPUT_MISSING, GPT4O_INPUT_1000)
    expect(row.reported?.kind).toBe('gateway_estimate')
    expect(row.labels.reportedCharge).toBeDefined()
    expectPriced(price(oneRow('F-csv', spendLog({}))), GPT4O_INPUT_1000)
  })

  it('embedding and aembedding calls bill input only, so an absent output leaves them priced', () => {
    for (const callType of ['embedding', 'aembedding']) {
      const raw = oneRow('F-csv', spendLog({ call_type: callType, model: 'text-embedding-3-small', spend: '0.00002', completion_tokens: '' }))
      expect(raw.operation).toBe('embedding')
      expect(raw.notMeasured).toContain('output')
      expectPriced(price(raw), EMBED_INPUT_1000)
    }
    const zero = oneRow('F-csv', spendLog({ call_type: 'aembedding', model: 'text-embedding-3-small', spend: '0.00002' }))
    expect(zero.operation).toBe('embedding')
    expectPriced(price(zero), EMBED_INPUT_1000)
  })

  it('chat call types stay generate', () => {
    expect(oneRow('F-csv', spendLog({})).operation ?? 'generate').toBe('generate')
  })
})

describe('G: OpenTelemetry spans', () => {
  const chatAttrs: Attr[] = [
    ['gen_ai.operation.name', 'chat'],
    ['gen_ai.provider.name', 'openai'],
    ['gen_ai.request.model', 'gpt-4o'],
  ]
  const embedAttrs: Attr[] = [
    ['gen_ai.operation.name', 'embeddings'],
    ['gen_ai.provider.name', 'openai'],
    ['gen_ai.request.model', 'text-embedding-3-small'],
  ]

  it('absent vs explicit 0', () => {
    const absent = oneRow('G-otlp', span([...chatAttrs, ['gen_ai.usage.input_tokens', 1000]]))
    expect(absent.notMeasured).toContain('output')
    expect(absent.mapping).toContain('output = not measured (gen_ai.usage.output_tokens absent)')
    expect(oneRow('G-otlp', span([...chatAttrs, ['gen_ai.usage.input_tokens', 1000], ['gen_ai.usage.output_tokens', 0]])).notMeasured).not.toContain('output')
    expect(oneRow('G-otlp', span([...chatAttrs, ['gen_ai.usage.output_tokens', 10]])).notMeasured).toContain('uncachedInput')
  })

  it('priced chat span', () => {
    expectUnresolvedMissing(price(oneRow('G-otlp', span([...chatAttrs, ['gen_ai.usage.input_tokens', 1000]]))), OUTPUT_MISSING, GPT4O_INPUT_1000)
    expectPriced(price(oneRow('G-otlp', span([...chatAttrs, ['gen_ai.usage.input_tokens', 1000], ['gen_ai.usage.output_tokens', 0]]))), GPT4O_INPUT_1000)
  })

  it('an embeddings span bills input only and stays priced', () => {
    const row = oneRow('G-otlp', span([...embedAttrs, ['gen_ai.usage.input_tokens', 1000]]))
    expect(row.operation).toBe('embedding')
    expect(row.counted).toBe(true)
    expectPriced(price(row), EMBED_INPUT_1000)
    // An embeddings span still needs its input.
    const noInput = oneRow('G-otlp', span([...embedAttrs, ['gen_ai.usage.cache_read.input_tokens', 0]]))
    expect(noInput.operation).toBe('embedding')
    expectUnresolvedMissing(price(noInput), INPUT_MISSING, 0n)
  })

  it('the embeddings span in the OTLP fixture stays priced', () => {
    const rows = runAdapter('G-otlp', fixtureRecords('g-otel-spans.json', 'G-otlp'))
    const embed = rows.find((r) => r.modelLogged === 'text-embedding-3-small')
    expect(embed?.operation).toBe('embedding')
    const priced = price(embed!)
    expect(priced.cost.label.kind).toBe('Estimated')
    expect(priced.flags).not.toContain('billed_class_missing')
    // Chat spans in the same file keep the default operation.
    for (const r of rows.filter((x) => x.modelLogged !== 'text-embedding-3-small')) expect(r.operation).toBeUndefined()
  })
})

describe('H: custom CSV', () => {
  const row = (cells: Record<string, string>) => csv({ vendor: 'openai', model_name: 'gpt-4o', input_tok: '1000', output_tok: '0', billed_usd: '', ...cells })

  it('output column unmapped or the cell empty => Not measured; "0" is measured', () => {
    const unmapped = oneRow('H-csv', row({}), H_MAPPING({ outputTokens: null }))
    expect(unmapped.notMeasured).toContain('output')
    expect(unmapped.mapping).toContain('output = not measured (no column mapped)')
    const empty = oneRow('H-csv', row({ output_tok: '' }), H_MAPPING())
    expect(empty.notMeasured).toContain('output')
    expect(empty.mapping).toContain('output = not measured (column output_tok empty)')
    expect(oneRow('H-csv', row({}), H_MAPPING()).notMeasured).not.toContain('output')
    expect(oneRow('H-csv', row({ input_tok: '' }), H_MAPPING()).notMeasured).toContain('uncachedInput')
  })

  it('priced: no charge, a mapped charge, and both classes missing', () => {
    expectUnresolvedMissing(price(oneRow('H-csv', row({ output_tok: '' }), H_MAPPING())), OUTPUT_MISSING, GPT4O_INPUT_1000)
    expectPriced(price(oneRow('H-csv', row({}), H_MAPPING())), GPT4O_INPUT_1000)
    const charged = oneRow('H-csv', row({ output_tok: '', billed_usd: '0.0031' }), H_MAPPING({ reportedCharge: 'billed_usd' }))
    expect(charged.reported).toEqual({ amountUsd: '0.0031', field: 'billed_usd', kind: 'charge' })
    expectChargeKept(price(charged), '0.0031', GPT4O_INPUT_1000, 'output')
    expectUnresolvedMissing(price(oneRow('H-csv', row({ input_tok: '', output_tok: '' }), H_MAPPING())), BOTH_MISSING, null)
  })
})

describe('fixtures end to end', () => {
  async function importFixture(file: string) {
    const bytes = readFileSync(join(FIXTURES, file))
    const detection = detectFromSample(bytes.subarray(0, 65536).toString('utf8'), file)
    expect(detection.variant).not.toBeNull()
    const rows: AuditRow[] = []
    const summary = await runImport({
      file: new Blob([bytes]),
      fileName: file,
      variant: detection.variant!,
      detection,
      overridden: false,
      mapping: null,
      snapshot,
      snapshotMeta: meta,
      signal: new AbortController().signal,
      sink: { write: async (r) => void rows.push(...r) },
      onProgress: () => {},
    })
    return { detection, rows, summary }
  }

  it('edge-missing-output.jsonl: the absent row is Unresolved, the explicit 0 row priced, the total partial with the reason', async () => {
    const { detection, rows, summary } = await importFixture('edge-missing-output.jsonl')
    expect(detection.variant).toBe('A-jsonl')
    expect(rows).toHaveLength(2)
    expectUnresolvedMissing(rows[0]!, OUTPUT_MISSING, GPT4O_INPUT_1000)
    expectPriced(rows[1]!, GPT4O_INPUT_1000)
    expect(summary.coverage).toMatchObject({ totalRows: 2, rowsPriced: 1, rowsUnresolved: 1, rowsNotPriced: 0 })
    expect(usdToFemto(summary.totals.value.exactUsd)).toBe(GPT4O_INPUT_1000)
    expect(summary.totals.partial).toBe(true)
    expect(summary.totals.partialReason).toContain('Unresolved')
    expect(summary.totals.partialReason).toContain('output tokens missing')
  })

  it('edge-missing-output-charge.jsonl: the charge is kept, the row without a charge is Unresolved', async () => {
    const { detection, rows, summary } = await importFixture('edge-missing-output-charge.jsonl')
    expect(detection.variant).toBe('E-jsonl')
    expect(rows).toHaveLength(2)
    expectChargeKept(rows[0]!, '0.0031', GPT4O_INPUT_1000, 'output')
    expectUnresolvedMissing(rows[1]!, OUTPUT_MISSING, GPT4O_INPUT_1000)
    expect(summary.coverage).toMatchObject({ totalRows: 2, rowsPriced: 1, rowsUnresolved: 1 })
    expect(usdToFemto(summary.totals.measuredCharge.exactUsd)).toBe(usdToFemto('0.0031'))
    expect(usdToFemto(summary.totals.value.exactUsd)).toBe(usdToFemto('0.0031'))
    expect(summary.totals.partial).toBe(true)
    expect(summary.totals.partialReason).toContain('output tokens missing')
  })

  it('the Aggregator names the missing class in the partial reason', () => {
    const agg = new Aggregator()
    const priced = price(oneRow('A-jsonl', chat({ prompt_tokens: 1000, completion_tokens: 0 })), 0)
    const missing = price(oneRow('A-jsonl', chat({ prompt_tokens: 1000 })), 1)
    agg.add(priced)
    agg.add(missing)
    const s = agg.summary()
    expect(s.totals.partial).toBe(true)
    expect(s.totals.partialReason).toContain('1 row Unresolved')
    expect(s.totals.partialReason).toContain('output tokens missing')
    expect(usdToFemto(s.totals.value.exactUsd)).toBe(GPT4O_INPUT_1000)
  })
})
