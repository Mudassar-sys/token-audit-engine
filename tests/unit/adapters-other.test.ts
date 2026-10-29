import Papa from 'papaparse'
import { describe, expect, it } from 'vitest'
import { CustomCsvMapping, NormalizedUsageRow, type VariantId } from '../../src/engine/contracts'
import { anthropicAdapter, normalizeAnthropicMessage } from '../../src/engine/adapters/anthropic'
import { customCsvAdapter, tierFromCell } from '../../src/engine/adapters/customCsv'
import { LITELLM_INCLUSION_FACT, litellmAdapter, scanLiteLlmInclusion } from '../../src/engine/adapters/litellm'
import { anyValue, otelAdapter } from '../../src/engine/adapters/otel'
import type { AdapterRow, RawRecord } from '../../src/engine/adapters/types'
import { streamRecords } from '../../src/engine/stream'
import { expectedFor, expectedView, fixtureRecords, fixtureText, runAdapter, withIndex } from './helpers/otherFixtures'

const MAPPING = CustomCsvMapping.parse(JSON.parse(fixtureText('h-custom-mapping.json')))

const FIXTURE_VARIANTS: [string, VariantId][] = [
  ['d-anthropic-messages.json', 'D-json'],
  ['d-anthropic-messages.jsonl', 'D-jsonl'],
  ['edge-malformed.jsonl', 'D-jsonl'],
  ['f-litellm-spend.csv', 'F-csv'],
  ['f-litellm-spend.json', 'F-json'],
  ['edge-bom.csv', 'F-csv'],
  ['edge-quoted-newlines.csv', 'F-csv'],
  ['edge-multibyte-boundary.csv', 'F-csv'],
  ['zero-valid-explicit-rate.json', 'F-json'],
  ['zero-unresolved.json', 'F-json'],
  ['g-otel-spans.json', 'G-otlp'],
  ['g-otel-spans.jsonl', 'G-otlp-jsonl'],
  ['h-custom.csv', 'H-csv'],
  ['edge-missing-columns.csv', 'H-csv'],
]

function rowsOf(file: string, variant: VariantId): AdapterRow[] {
  return runAdapter(variant, fixtureRecords(file, variant), variant === 'H-csv' ? MAPPING : null)
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function json(value: unknown, line: number | null = null): RawRecord {
  return { kind: 'json', value, line }
}

function csvRow(row: Record<string, string>, line = 2): RawRecord {
  return { kind: 'csv', row, line }
}

describe('every fixture', () => {
  for (const [file, variant] of FIXTURE_VARIANTS) {
    it(`${file} (${variant}) normalizes to the expected rows`, () => {
      const rows = rowsOf(file, variant)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of withIndex(rows)) expect(() => NormalizedUsageRow.parse(r)).not.toThrow()
      for (const r of rows) expect(r.variant).toBe(variant)
      const view = expectedView(rows)
      expect(view).toEqual(expectedFor(file, view))
    })
  }

  it('CSV fixtures read with Papa.parse on the string give the same rows', () => {
    for (const [file, variant] of FIXTURE_VARIANTS) {
      if (!file.endsWith('.csv') || file === 'edge-missing-columns.csv') continue
      const parsed = Papa.parse<Record<string, string>>(stripBom(fixtureText(file)), { header: true, skipEmptyLines: 'greedy' })
      expect(parsed.errors).toEqual([])
      const records = parsed.data.map((row, i) => csvRow(row, i + 2))
      const direct = runAdapter(variant, records, variant === 'H-csv' ? MAPPING : null)
      expect(expectedView(direct)).toEqual(expectedView(rowsOf(file, variant)))
    }
  })
})

describe('Anthropic Messages (D)', () => {
  it('reads the documented caching example without subtracting anything from input_tokens', () => {
    const row = normalizeAnthropicMessage(
      {
        type: 'message',
        model: 'claude-sonnet-4-5-20250929',
        usage: {
          input_tokens: 2048,
          cache_read_input_tokens: 1800,
          cache_creation_input_tokens: 248,
          output_tokens: 503,
          cache_creation: { ephemeral_5m_input_tokens: 148, ephemeral_1h_input_tokens: 100 },
        },
      },
      'D-json',
    )
    expect(row.tokens).toEqual({ uncachedInput: 2048, cacheRead: 1800, cacheWrite: { '5m': 148, '1h': 100, '30m': 0, '12h': 0 }, output: 503, reasoning: null })
    expect(row.flags).toEqual([])
    expect(row.unresolvedReason).toBeNull()
    expect(row.notMeasured).toEqual(['reasoning'])
    expect(row.tierStated).toBeNull()
    expect(row.provider).toBe('anthropic')
    expect(row.timestamp).toBeNull()
    expect(row.raw['usage.cache_creation.ephemeral_1h_input_tokens']).toBe(100)
    expect(row.mapping.join('\n')).toContain('uncachedInput = usage.input_tokens')
  })

  it('assumes 5m when only cache_creation_input_tokens is logged', () => {
    const rows = rowsOf('d-anthropic-messages.json', 'D-json')
    const r = rows[1]!
    expect(r.tokens.cacheWrite).toEqual({ '5m': 1024, '1h': 0, '30m': 0, '12h': 0 })
    expect(r.flags).toContain('duration_assumed')
    expect(r.tierStated).toBe('standard')
  })

  it('keeps thinking tokens inside output, reads batch tier and excludes web search requests', () => {
    const rows = rowsOf('d-anthropic-messages.json', 'D-json')
    expect(rows[2]!.tokens.output).toBe(2400)
    expect(rows[2]!.tokens.reasoning).toBe(1800)
    expect(rows[3]!.tierStated).toBe('batch')
    expect(rows[4]!.excluded).toEqual({ web_search_requests: 3 })
    expect(rows[0]!.raw.id).toBe('msg_ZQXMARK-d-anthropic-messages-8cccb931')
  })

  it('keeps speed and inference_geo in raw for pricing', () => {
    const rows = rowsOf('d-anthropic-messages.jsonl', 'D-jsonl')
    const fast = rows[5]!
    expect(fast.raw['usage.speed']).toBe('fast')
    expect(fast.raw['usage.inference_geo']).toBe('us')
    expect(fast.tierStated).toBe('priority')
    expect(rows[4]!.excluded).toEqual({ web_search_requests: 2, web_fetch_requests: 1 })
  })

  it('flags a 5m plus 1h breakdown that disagrees with the total', () => {
    const row = normalizeAnthropicMessage(
      { type: 'message', model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 100 } } },
      'D-json',
    )
    expect(row.flags).toContain('totals_disagree')
    expect(row.unresolvedReason).toContain('differs')
  })

  it('turns broken lines, error objects and invalid counts into malformed rows', () => {
    const rows = rowsOf('edge-malformed.jsonl', 'D-jsonl')
    expect(rows).toHaveLength(7)
    expect(rows.map((r) => r.flags.includes('malformed'))).toEqual([false, true, true, true, true, true, false])
    expect(rows[1]!.unresolvedReason).toMatch(/^Malformed: Line 2 is not valid JSON/)
    expect(rows[3]!.unresolvedReason).toContain('type is "error"')
    expect(rows[4]!.unresolvedReason).toContain('usage.input_tokens')
    expect(rows[5]!.unresolvedReason).toContain('no usage object')
    expect(rows[6]!.tokens.cacheRead).toBe(1200)
  })

  it('scores Messages API records high and other shapes low', () => {
    expect(anthropicAdapter.score(json({ type: 'message', usage: { input_tokens: 1, output_tokens: 1 } })).score).toBeGreaterThan(0.9)
    expect(anthropicAdapter.score(json({ object: 'chat.completion', usage: { prompt_tokens: 1 } })).score).toBe(0)
    expect(anthropicAdapter.score(csvRow({ a: '1' })).score).toBe(0)
  })
})

describe('LiteLLM spend logs (F)', () => {
  const header = (o: Record<string, string>) => ({
    request_id: 'r',
    call_type: 'acompletion',
    spend: '0.001',
    prompt_tokens: '0',
    completion_tokens: '0',
    startTime: '2026-10-01 10:00:00.000',
    model: 'gpt-4o',
    custom_llm_provider: 'openai',
    metadata: '{}',
    ...o,
  })

  it('assumes the documented default (prompt_tokens includes cache) when no row proves otherwise', () => {
    const records = fixtureRecords('f-litellm-spend.csv', 'F-csv')
    const facts = litellmAdapter.scanFileFacts!(records)
    expect(facts[LITELLM_INCLUSION_FACT]).toMatchObject({ mode: 'included', basis: 'assumed' })
    const rows = runAdapter('F-csv', records)
    expect(rows[0]!.tokens.uncachedInput).toBe(86)
    expect(rows[0]!.tokens.cacheRead).toBe(1920)
    expect(rows[0]!.flags).toContain('inclusion_assumed')
    expect(rows[1]!.tokens).toEqual({ uncachedInput: 2048, cacheRead: 1800, cacheWrite: { '5m': 248, '1h': 0, '30m': 0, '12h': 0 }, output: 503, reasoning: null })
    expect(rows[1]!.flags).toEqual(['inclusion_assumed', 'duration_assumed'])
    expect(rows[2]!.flags).toEqual([])
    expect(rows[0]!.reported).toEqual({ amountUsd: '0.005615', field: 'spend', kind: 'gateway_estimate' })
    expect(rows[3]!.reported).toEqual({ amountUsd: '0', field: 'spend', kind: 'gateway_estimate' })
    expect(rows[0]!.provider).toBe('openai')
    expect(rows[0]!.timestamp).toBe('2026-10-01T09:15:02.114Z')
  })

  it('falls back to metadata.usage_object and splits writes by provider', () => {
    const rows = rowsOf('f-litellm-spend.csv', 'F-csv')
    const r = rows[4]!
    expect(r.tokens).toEqual({ uncachedInput: 1500, cacheRead: 1000, cacheWrite: { '5m': 0, '1h': 0, '30m': 500, '12h': 0 }, output: 900, reasoning: 400 })
    expect(r.mapping.join('\n')).toContain('metadata.usage_object.prompt_tokens_details.cache_write_tokens')
  })

  it('detects exclusion when a row has more cached tokens than prompt_tokens', () => {
    const records = [
      csvRow(header({ prompt_tokens: '500', metadata: JSON.stringify({ additional_usage_values: { cache_read_input_tokens: 3000 } }) })),
      csvRow(header({ prompt_tokens: '400', metadata: JSON.stringify({ additional_usage_values: { cache_read_input_tokens: 100 } }) })),
      csvRow(header({ prompt_tokens: '400' })),
    ]
    const fact = scanLiteLlmInclusion(records)
    expect(fact.mode).toBe('excluded')
    expect(fact.basis).toBe('detected')
    expect(fact.evidence).toContain('exceed prompt_tokens 500')
    const rows = runAdapter('F-csv', records)
    expect(rows[0]!.tokens.uncachedInput).toBe(500)
    expect(rows[0]!.tokens.cacheRead).toBe(3000)
    expect(rows[1]!.tokens.uncachedInput).toBe(400)
    expect(rows[1]!.flags).toContain('inclusion_detected')
    expect(rows[2]!.flags).not.toContain('inclusion_detected')
  })

  it('needs no decision when no row has cached tokens', () => {
    const fact = scanLiteLlmInclusion([csvRow(header({ prompt_tokens: '10' }))])
    expect(fact).toMatchObject({ mode: 'included', basis: 'no_cache_tokens', rowsWithCache: 0 })
  })

  it('uses the assumed default without file facts and marks a contradicting row Unresolved', () => {
    const run = litellmAdapter.begin({ variant: 'F-csv', mapping: null, fileFacts: {} })
    const [ok] = run.push(csvRow(header({ prompt_tokens: '1000', metadata: '{"additional_usage_values":{"cache_read_input_tokens":400}}' })))
    expect(ok!.tokens.uncachedInput).toBe(600)
    expect(ok!.flags).toContain('inclusion_assumed')
    const [late] = run.push(csvRow(header({ prompt_tokens: '100', metadata: '{"additional_usage_values":{"cache_read_input_tokens":400}}' })))
    expect(late!.flags).toContain('cache_exceeds_input')
    expect(late!.unresolvedReason).toContain('contradicts')
    expect(late!.tokens.uncachedInput).toBe(0)
  })

  it('marks disagreeing metadata fields, broken metadata and non-numeric counts', () => {
    const run = litellmAdapter.begin({ variant: 'F-csv', mapping: null, fileFacts: {} })
    const [a] = run.push(csvRow(header({ prompt_tokens: '1000', metadata: '{"additional_usage_values":{"cache_read_input_tokens":400},"usage_object":{"prompt_tokens_details":{"cached_tokens":300}}}' })))
    expect(a!.flags).toContain('totals_disagree')
    expect(a!.unresolvedReason).toContain('disagree')
    const [b] = run.push(csvRow(header({ prompt_tokens: '1000', metadata: '{not json' })))
    expect(b!.unresolvedReason).toContain('metadata is not valid JSON')
    const [c] = run.push(csvRow(header({ prompt_tokens: 'abc' })))
    expect(c!.flags).toEqual(['malformed'])
    const [d] = run.push(csvRow(header({ spend: 'free' })))
    expect(d!.flags).toEqual(['malformed'])
    const [e] = run.push({ kind: 'error', message: 'Line 9: TooFewFields: Too few fields', raw: 'x,y', line: 9 })
    expect(e!.unresolvedReason).toBe('Malformed: Line 9: TooFewFields: Too few fields')
  })

  it('keeps prompt and response content out of raw', () => {
    const rows = rowsOf('edge-quoted-newlines.csv', 'F-csv')
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.raw).not.toHaveProperty('messages')
      expect(r.raw).not.toHaveProperty('response')
      expect(r.raw).not.toHaveProperty('metadata')
    }
    expect(rows[0]!.tokens.cacheRead).toBe(1024)
    expect(rows[1]!.tokens.cacheWrite['5m']).toBe(400)
  })

  it('reads a BOM file with the first column intact', () => {
    const rows = rowsOf('edge-bom.csv', 'F-csv')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.raw.request_id).toBe('ZQXMARK-edge-bom-4730367a')
  })

  it('reads JSON spend logs with numbers and metadata objects', () => {
    const rows = rowsOf('f-litellm-spend.json', 'F-json')
    expect(rows[0]!.tokens.uncachedInput).toBe(500)
    expect(rows[0]!.tokens.cacheWrite['5m']).toBe(300)
    expect(rows[0]!.reported?.amountUsd).toBe('0.00243')
    expect(rows[3]!.modelLogged).toBeNull()
    expect(rows[3]!.flags).toContain('model_missing')
  })

  it('reports spend 0 as a gateway estimate of exactly 0 for both zero fixtures', () => {
    for (const f of ['zero-valid-explicit-rate.json', 'zero-unresolved.json']) {
      const [row] = rowsOf(f, 'F-json')
      expect(row!.reported).toEqual({ amountUsd: '0', field: 'spend', kind: 'gateway_estimate' })
      expect(row!.unresolvedReason).toBeNull()
    }
    expect(rowsOf('zero-valid-explicit-rate.json', 'F-json')[0]!.modelLogged).toBe('codestral/codestral-latest')
  })

  it('reads the multibyte fixture the same way through the stream reader with a tiny chunk size', async () => {
    const bytes = new TextEncoder().encode(fixtureText('edge-multibyte-boundary.csv'))
    const records: RawRecord[] = []
    await streamRecords(new Blob([bytes]), 'csv', { signal: new AbortController().signal, onBytes() {}, onChunk() {}, csvChunkSize: 7 }, (r) => void records.push(...r))
    const rows = runAdapter('F-csv', records)
    expect(rows).toHaveLength(40)
    expect(expectedView(rows)).toEqual(expectedView(rowsOf('edge-multibyte-boundary.csv', 'F-csv')))
    expect(rows.some((r) => r.flags.includes('malformed'))).toBe(false)
  })
})

describe('OpenTelemetry spans (G)', () => {
  const byName = (rows: AdapterRow[], name: string) => {
    const r = rows.find((x) => x.raw.name === name)
    if (!r) throw new Error(`no row for span ${name}`)
    return r
  }

  it('buffers spans and emits rows only in finish()', () => {
    const run = otelAdapter.begin({ variant: 'G-otlp', mapping: null, fileFacts: {} })
    const records = fixtureRecords('g-otel-spans.json', 'G-otlp')
    expect(records).toHaveLength(2)
    for (const r of records) expect(run.push(r)).toEqual([])
    expect(run.finish()).toHaveLength(9)
  })

  it('never adds an aggregate span to its children', () => {
    const rows = rowsOf('g-otel-spans.json', 'G-otlp')
    const agent = byName(rows, 'invoke_agent planner')
    expect(agent.counted).toBe(false)
    expect(agent.flags).toContain('aggregate_span')
    expect(agent.flags).not.toContain('aggregate_mismatch')
    expect(agent.mapping.join('\n')).toContain('sum of 2 counted descendant span(s): input 3000, output 700 (match)')
    const trace = rows.filter((r) => r.raw.traceId === '5b8efff798038103d269b633813fc60c' && r.counted)
    expect(trace).toHaveLength(2)
    const input = trace.reduce((a, r) => a + r.tokens.uncachedInput + r.tokens.cacheRead + r.tokens.cacheWrite['5m'] + r.tokens.cacheWrite['30m'], 0)
    expect(input).toBe(3000)
  })

  it('flags an aggregate whose children do not add up', () => {
    const rows = rowsOf('g-otel-spans.json', 'G-otlp')
    const wf = byName(rows, 'invoke_workflow nightly')
    expect(wf.counted).toBe(false)
    expect(wf.flags).toEqual(expect.arrayContaining(['aggregate_span', 'aggregate_mismatch']))
    expect(wf.mapping.join('\n')).toContain('Own input 5000, output 1000; sum of 1 counted descendant span(s): input 4000, output 900 (mismatch)')
  })

  it('marks cache reads above input as Unresolved', () => {
    const rows = rowsOf('g-otel-spans.json', 'G-otlp')
    const r = rows.find((x) => x.raw.spanId === 'f60708192a3b4c5d')!
    expect(r.counted).toBe(true)
    expect(r.flags).toContain('cache_exceeds_input')
    expect(r.unresolvedReason).toBe('cache tokens exceed input tokens; no documented producer rule')
  })

  it('flags a span without operation name that overlaps a counted child', () => {
    const rows = rowsOf('g-otel-spans.json', 'G-otlp')
    const parent = byName(rows, 'llm.request')
    expect(parent.counted).toBe(true)
    expect(parent.flags).toContain('overlaps_counted_child')
    expect(parent.unresolvedReason).toBe('overlaps a counted child span; review needed')
    const child = byName(rows, 'chat gpt-4o-mini')
    expect(child.flags).toEqual([])
    expect(child.unresolvedReason).toBeNull()
  })

  it('accepts cache_creation and cache_write names and splits writes by provider', () => {
    const rows = rowsOf('g-otel-spans.json', 'G-otlp')
    const sonnet = byName(rows, 'chat claude-sonnet-4-5')
    expect(sonnet.tokens).toEqual({ uncachedInput: 300, cacheRead: 1200, cacheWrite: { '5m': 300, '1h': 0, '30m': 0, '12h': 0 }, output: 400, reasoning: 120 })
    expect(sonnet.modelLogged).toBe('claude-sonnet-4-5-20250929')
    expect(sonnet.mapping.join('\n')).toContain('gen_ai.usage.cache_creation.input_tokens')
    const gpt = rows.find((r) => r.raw.spanId === 'c3d4e5f60708192a')!
    expect(gpt.tokens.cacheWrite).toEqual({ '5m': 0, '1h': 0, '30m': 200, '12h': 0 })
    expect(gpt.tokens.uncachedInput).toBe(1000)
    expect(gpt.flags).toContain('duration_assumed')
    const both = rowsOf('g-otel-spans.jsonl', 'G-otlp-jsonl').find((r) => r.raw.spanId === '5555555555555555')!
    expect(both.flags).toContain('totals_disagree')
    expect(both.unresolvedReason).toContain('differs from gen_ai.usage.cache_creation.input_tokens')
  })

  it('reads intValue given as strings and as numbers', () => {
    expect(anyValue({ intValue: '1200' })).toBe('1200')
    expect(anyValue({ intValue: 1200 })).toBe(1200)
    expect(anyValue({ kvlistValue: { values: [{ key: 'a', value: { boolValue: true } }] } })).toEqual({ a: true })
    expect(anyValue({ arrayValue: { values: [{ stringValue: 'x' }, { doubleValue: 1.5 }] } })).toEqual(['x', 1.5])
    const rows = rowsOf('g-otel-spans.json', 'G-otlp')
    expect(byName(rows, 'chat claude-sonnet-4-5').raw['gen_ai.usage.input_tokens']).toBe('1800')
    const jsonl = rowsOf('g-otel-spans.jsonl', 'G-otlp-jsonl')
    expect(byName(jsonl, 'chat claude-haiku-4-5').raw['gen_ai.usage.input_tokens']).toBe(2500)
    expect(byName(jsonl, 'chat claude-haiku-4-5').tokens.uncachedInput).toBe(400)
  })

  it('resolves parents that arrive in a later record, legacy names, fetch_response and image input', () => {
    const rows = rowsOf('g-otel-spans.jsonl', 'G-otlp-jsonl')
    const agent = byName(rows, 'invoke_agent support')
    expect(agent.counted).toBe(false)
    expect(agent.flags).not.toContain('aggregate_mismatch')
    const legacy = byName(rows, 'text_completion legacy')
    expect(legacy.provider).toBe('openai')
    expect(legacy.tokens.uncachedInput).toBe(640)
    expect(legacy.tokens.output).toBe(64)
    expect(legacy.mapping.join('\n')).toContain('gen_ai.usage.prompt_tokens')
    const fetch = byName(rows, 'fetch_response')
    expect(fetch.unresolvedReason).toContain('fetch_response')
    const image = byName(rows, 'generate_content gpt-4o')
    expect(image.tokens.uncachedInput).toBe(1200)
    expect(image.excluded).toEqual({ input_image: 300 })
  })

  it('uses startTimeUnixNano for the timestamp and leaves spans without usage out', () => {
    const rows = rowsOf('g-otel-spans.json', 'G-otlp')
    expect(byName(rows, 'invoke_agent planner').timestamp).toBe('2026-10-01T09:00:00.000Z')
    expect(rows.find((r) => r.raw.name === 'execute_tool lookup_rates')).toBeUndefined()
    const emb = byName(rows, 'embeddings text-embedding-3-small')
    expect(emb.notMeasured).toEqual(['cacheRead', 'cacheWrite', 'output', 'reasoning'])
    expect(emb.tokens.uncachedInput).toBe(512)
  })

  it('leaves a repeated span (same traceId and spanId) unresolved instead of counting it twice', () => {
    const records = fixtureRecords('g-otel-spans.json', 'G-otlp')
    const rows = runAdapter('G-otlp', [...records, records[1]!])
    expect(rows).toHaveLength(15)
    const repeats = rows.slice(9)
    expect(repeats.every((r) => r.unresolvedReason?.includes('repeats an earlier span'))).toBe(true)
    expect(rows.slice(0, 9)).toEqual(rowsOf('g-otel-spans.json', 'G-otlp'))
  })

  it('makes a span with an invalid count malformed and keeps the rest', () => {
    const run = otelAdapter.begin({ variant: 'G-otlp-jsonl', mapping: null, fileFacts: {} })
    run.push(json({ resourceSpans: [{ scopeSpans: [{ spans: [
      { traceId: 'aa', spanId: '01', name: 'bad', attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }, { key: 'gen_ai.usage.input_tokens', value: { intValue: '-3' } }] },
      { traceId: 'aa', spanId: '02', name: 'good', attributes: [{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } }, { key: 'gen_ai.usage.input_tokens', value: { intValue: '30' } }] },
    ] }] }] }, 1))
    const out = run.push(json({ unrelated: true }, 2))
    expect(out[0]!.flags).toEqual(['malformed'])
    const rows = run.finish()
    expect(rows.map((r) => r.flags.includes('malformed'))).toEqual([true, false])
    expect(rows[1]!.tokens.uncachedInput).toBe(30)
  })
})

describe('Custom CSV (H)', () => {
  it('applies the mapping, including cached tokens inside input', () => {
    const rows = rowsOf('h-custom.csv', 'H-csv')
    expect(rows).toHaveLength(24)
    expect(rows[0]!.tokens).toEqual({ uncachedInput: 600, cacheRead: 400, cacheWrite: { '5m': 0, '1h': 0, '30m': 0, '12h': 0 }, output: 200, reasoning: 50 })
    expect(rows[0]!.tierStated).toBe('standard')
    expect(rows[0]!.timestamp).toBe('2026-10-10T08:15:00.000Z')
    expect(rows[1]!.tokens.cacheWrite['5m']).toBe(128)
    expect(rows[1]!.flags).toContain('duration_assumed')
    expect(rows[1]!.tierStated).toBeNull()
    expect(rows[2]!.tierStated).toBe('batch')
    expect(rows[2]!.reported).toEqual({ amountUsd: '0.003', field: 'billed_usd', kind: 'charge' })
    expect(rows[7]!.flags).toEqual(['malformed'])
    expect(rows[11]!.flags).toContain('cache_exceeds_input')
    expect(rows[11]!.unresolvedReason).toContain('exceed input tokens')
  })

  it('uses the mapped write duration and input that excludes cached tokens', () => {
    const run = customCsvAdapter.begin({ variant: 'H-csv', mapping: { ...MAPPING, inputIncludesCached: false, cacheWriteDuration: '1h' }, fileFacts: {} })
    const [row] = run.push(csvRow({ event_time: '', vendor: 'anthropic', model_name: 'm', input_tok: '100', cached_tok: '50', cache_write_tok: '20', output_tok: '5', reasoning_tok: '', service_level: 'SCALE', billed_usd: '', note: '' }))
    expect(row!.tokens.uncachedInput).toBe(100)
    expect(row!.tokens.cacheWrite).toEqual({ '5m': 0, '1h': 20, '30m': 0, '12h': 0 })
    expect(row!.flags).toEqual([])
    expect(row!.raw.service_tier).toBe('scale')
    expect(row!.tierStated).toBeNull()
  })

  it('labels missing cells Not measured and short rows malformed', () => {
    const rows = rowsOf('edge-missing-columns.csv', 'H-csv')
    expect(rows).toHaveLength(6)
    expect(rows[0]!.notMeasured).toEqual(['cacheWrite', 'reasoning'])
    expect(rows[0]!.tokens.uncachedInput).toBe(86)
    expect(rows[1]!.notMeasured).toEqual(['cacheRead', 'cacheWrite', 'reasoning'])
    expect(rows[2]!.notMeasured).toEqual(['output', 'reasoning'])
    expect(rows[2]!.modelLogged).toBeNull()
    expect(rows[2]!.timestamp).toBeNull()
    expect(rows[3]!.notMeasured).toContain('uncachedInput')
    expect(rows[3]!.reported?.amountUsd).toBe('0.0012')
    expect(rows[4]!.flags).toEqual(['malformed'])
    expect(rows[5]!.provider).toBeNull()
  })

  it('matches tier names case-insensitively and needs a mapping', () => {
    expect(tierFromCell('Batches')).toBe('batch')
    expect(tierFromCell(' PRIORITY ')).toBe('priority')
    expect(tierFromCell('default')).toBe('standard')
    expect(tierFromCell('gold')).toBeNull()
    const run = customCsvAdapter.begin({ variant: 'H-csv', mapping: null, fileFacts: {} })
    expect(run.push(csvRow({ a: '1' }))[0]!.unresolvedReason).toContain('no column mapping')
  })
})
