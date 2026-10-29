import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Papa from 'papaparse'
import { describe, expect, it } from 'vitest'
import { adapterForVariant } from '../../src/engine/adapters/index'
import { PricingSnapshot } from '../../src/engine/contracts'
import { contextThresholds } from '../../src/engine/pricing'
import {
  generateSampleChunks,
  generateSampleRows,
  mulberry32,
  SAMPLE_CHUNK_BYTES,
  SAMPLE_COLUMNS,
  SAMPLE_MAX_PROMPT_TOKENS,
  SAMPLE_UNKNOWN_MODELS,
  SAMPLE_WRITE_PROVIDERS,
  type SampleStats,
} from '../../src/engine/sample'
import { countCsvDataRows, createCsvRecordCounter } from '../../src/ui/benchmark'
import { TEST_SNAPSHOT } from './helpers/testSnapshot'

/** The stored snapshot the app ships and the benchmark prices with. */
const STORED = PricingSnapshot.parse(
  JSON.parse(readFileSync(join(process.cwd(), 'public', 'pricing', '2026-10-29-aa992e3f.json'), 'utf8')),
)

function usageOf(r: Record<string, string>): { read: number; write: number } {
  const u = (JSON.parse(r.metadata ?? '{}') as { additional_usage_values: Record<string, unknown> }).additional_usage_values
  const pd = (u.prompt_tokens_details ?? {}) as Record<string, number>
  return {
    read: Number(u.cache_read_input_tokens ?? pd.cached_tokens ?? 0),
    write: Number(u.cache_creation_input_tokens ?? pd.cache_write_tokens ?? 0),
  }
}

function generate(target: number, seed: number): { chunks: string[]; stats: SampleStats } {
  const it = generateSampleChunks(target, seed)
  const chunks: string[] = []
  for (;;) {
    const r = it.next()
    if (r.done) return { chunks, stats: r.value }
    chunks.push(r.value)
  }
}

/** Upper bound of one generated row, in bytes. */
const MAX_ROW = 1200

describe('mulberry32', () => {
  it('is deterministic per seed', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    const c = mulberry32(8)
    const xs = Array.from({ length: 5 }, () => a())
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs)
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(xs)
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
  })
})

describe('generateSampleChunks', () => {
  const TARGET = 400_000
  const { chunks, stats } = generate(TARGET, 42)
  const text = chunks.join('')
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true })
  const rows = parsed.data

  it('is deterministic for a seed and differs across seeds', () => {
    expect(generate(TARGET, 42).chunks.join('')).toBe(text)
    expect(generate(TARGET, 43).chunks.join('')).not.toBe(text)
  })

  it('stays at or just under the target size, ends on a full row, ASCII only', () => {
    expect(stats.bytes).toBe(text.length)
    expect(new TextEncoder().encode(text).byteLength).toBe(text.length)
    expect(stats.bytes).toBeLessThanOrEqual(TARGET)
    expect(TARGET - stats.bytes).toBeLessThan(MAX_ROW)
    expect(text.endsWith('\n')).toBe(true)
    expect(parsed.errors).toEqual([])
    expect(rows).toHaveLength(stats.rows)
    expect(stats.columns).toBe(SAMPLE_COLUMNS.length)
    expect(Object.values(stats.sourceMix).reduce((a, b) => a + b, 0)).toBe(stats.rows)
  })

  it('yields chunks of about 1 MiB', () => {
    const big = generate(3 * SAMPLE_CHUNK_BYTES + 12345, 1)
    expect(big.stats.bytes).toBeLessThanOrEqual(3 * SAMPLE_CHUNK_BYTES + 12345)
    expect(big.chunks.length).toBe(4)
    for (const c of big.chunks.slice(0, -1)) {
      expect(c.length).toBeGreaterThanOrEqual(SAMPLE_CHUNK_BYTES)
      expect(c.length).toBeLessThan(SAMPLE_CHUNK_BYTES + MAX_ROW)
    }
  })

  it('header matches LiteLLM spend log columns, so the F adapter scores it', () => {
    expect(parsed.meta.fields).toEqual([...SAMPLE_COLUMNS])
    for (const c of ['request_id', 'spend', 'prompt_tokens', 'completion_tokens', 'startTime', 'model', 'custom_llm_provider', 'metadata']) {
      expect(parsed.meta.fields).toContain(c)
    }
    const headerRow = Object.fromEntries(SAMPLE_COLUMNS.map((c) => [c, '']))
    expect(adapterForVariant('F-csv').score({ kind: 'csv', row: headerRow, line: 1 }).score).toBeGreaterThanOrEqual(0.8)
  })

  it('mixes providers and snapshot models, with unknown models and zero spend rows', () => {
    const models = new Set(rows.map((r) => r.model))
    for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-6.1-sol', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5', 'codestral/codestral-latest', 'gemini-2.5-flash']) {
      expect(models.has(m)).toBe(true)
      expect(TEST_SNAPSHOT.models[m]).toBeDefined()
    }
    expect([...SAMPLE_UNKNOWN_MODELS]).toEqual(['unlisted-model-x', 'internal-finetune-v3'])
    for (const m of SAMPLE_UNKNOWN_MODELS) {
      expect(models.has(m)).toBe(true)
      expect(TEST_SNAPSHOT.models[m]).toBeUndefined()
    }
    // Synthetic model names are neutral: no made-up company names.
    expect(text).not.toMatch(/acme/i)
    const unknown = rows.filter((r) => (SAMPLE_UNKNOWN_MODELS as readonly string[]).includes(r.model ?? ''))
    expect(unknown.length / rows.length).toBeGreaterThan(0.005)
    expect(unknown.length / rows.length).toBeLessThan(0.05)
    const zeroOnPriced = rows.filter((r) => r.spend === '0' && r.model !== 'codestral/codestral-latest' && Number(r.prompt_tokens) > 0)
    expect(zeroOnPriced.length).toBeGreaterThan(0)
    expect(zeroOnPriced.length / rows.length).toBeLessThan(0.03)
    expect(Object.keys(stats.sourceMix).sort()).toEqual(['anthropic', 'codestral', 'gemini', 'hosted_vllm', 'openai'])
  })

  it('carries cached, cache write and reasoning tokens in the metadata JSON, never above prompt tokens', () => {
    let cached = 0
    let writes = 0
    let reasoning = 0
    for (const r of rows) {
      const meta = JSON.parse(r.metadata ?? '{}') as { additional_usage_values: Record<string, unknown> }
      const u = meta.additional_usage_values
      const pd = (u.prompt_tokens_details ?? {}) as Record<string, number>
      const read = Number(u.cache_read_input_tokens ?? pd.cached_tokens ?? 0)
      const write = Number(u.cache_creation_input_tokens ?? pd.cache_write_tokens ?? 0)
      const reason = Number(((u.completion_tokens_details ?? {}) as Record<string, number>).reasoning_tokens ?? 0)
      if (read > 0) cached++
      if (write > 0) writes++
      if (reason > 0) reasoning++
      expect(read + write).toBeLessThanOrEqual(Number(r.prompt_tokens))
      expect(reason).toBeLessThanOrEqual(Number(r.completion_tokens))
      expect(Number(r.total_tokens)).toBe(Number(r.prompt_tokens) + Number(r.completion_tokens))
      expect(r.spend).toMatch(/^\d+(\.\d+)?$/)
    }
    expect(cached).toBeGreaterThan(0)
    expect(writes).toBeGreaterThan(0)
    expect(reasoning).toBeGreaterThan(0)
  })

  it('timestamps fall within 30 days', () => {
    const times = rows.map((r) => Date.parse(r.startTime ?? ''))
    const span = Math.max(...times) - Math.min(...times)
    expect(times.every((t) => Number.isFinite(t))).toBe(true)
    expect(span).toBeLessThanOrEqual(30 * 86_400_000)
    expect(span).toBeGreaterThan(20 * 86_400_000)
  })

  it('a target below the header size yields nothing', () => {
    expect(generate(10, 1)).toEqual({
      chunks: [],
      stats: { bytes: 0, rows: 0, columns: SAMPLE_COLUMNS.length, sourceMix: {}, seed: 1, expectedNotPriced: 0, expectedUnresolved: 0 },
    })
  })

  it('stats carry the seed and the rows written to be Not priced and Unresolved', () => {
    expect(stats.seed).toBe(42)
    const unknown = (m: string | undefined) => (SAMPLE_UNKNOWN_MODELS as readonly string[]).includes(m ?? '')
    const notPriced = rows.filter((r) => unknown(r.model))
    // Spend 0 on a listed model whose rates are not all zero. Unknown models stay Not priced even at spend 0.
    const unresolved = rows.filter((r) => {
      const entry = r.model ? STORED.models[r.model] : undefined
      return entry !== undefined && Number(r.spend) === 0 && Object.values(entry.rates).some((v) => Number(v) !== 0)
    })
    expect(stats.expectedNotPriced).toBe(notPriced.length)
    expect(stats.expectedUnresolved).toBe(unresolved.length)
    expect(notPriced.length).toBeGreaterThan(0)
    expect(unresolved.length).toBeGreaterThan(0)
  })
})

describe('sample rows the engine can price', () => {
  const { chunks, stats } = generateSampleRows(6000, 7)
  const rows = Papa.parse<Record<string, string>>(chunks.join(''), { header: true, skipEmptyLines: true }).data

  it('always writes prompt_tokens and completion_tokens as integers', () => {
    for (const r of rows) {
      expect(r.prompt_tokens).toMatch(/^\d+$/)
      expect(r.completion_tokens).toMatch(/^\d+$/)
    }
  })

  it('writes cache writes only for providers with a documented duration, on models with a write rate', () => {
    let writes = 0
    for (const r of rows) {
      if (usageOf(r).write === 0) continue
      writes++
      expect(SAMPLE_WRITE_PROVIDERS.has(r.custom_llm_provider ?? '')).toBe(true)
      expect(STORED.models[r.model ?? '']?.rates.cache_creation_input_token_cost).toBeDefined()
    }
    expect(writes).toBeGreaterThan(0)
    for (const provider of ['gemini', 'codestral', 'hosted_vllm']) expect(SAMPLE_WRITE_PROVIDERS.has(provider)).toBe(false)
  })

  it('keeps every prompt below the long-context thresholds of its model', () => {
    let largest = 0
    for (const r of rows) {
      const prompt = Number(r.prompt_tokens)
      largest = Math.max(largest, prompt)
      expect(prompt).toBeLessThanOrEqual(SAMPLE_MAX_PROMPT_TOKENS)
      const entry = STORED.models[r.model ?? '']
      if (entry) for (const th of contextThresholds(entry)) expect(prompt).toBeLessThanOrEqual(th)
    }
    expect(largest).toBeGreaterThan(100_000)
  })

  it('every listed model has the rates its rows need', () => {
    for (const r of rows) {
      const entry = STORED.models[r.model ?? '']
      if (!entry) continue
      const { read, write } = usageOf(r)
      if (Number(r.prompt_tokens) - read - write > 0) expect(entry.rates.input_cost_per_token).toBeDefined()
      if (read > 0) expect(entry.rates.cache_read_input_token_cost).toBeDefined()
      expect(entry.rates.output_cost_per_token).toBeDefined()
    }
  })

  it('generateSampleRows writes exactly the asked rows, the same rows as generateSampleChunks', () => {
    expect(rows).toHaveLength(6000)
    expect(stats.rows).toBe(6000)
    expect(stats.seed).toBe(7)
    const text = chunks.join('')
    expect(stats.bytes).toBe(text.length)
    const prefix = generate(stats.bytes, 7)
    expect(prefix.chunks.join('')).toBe(text)
    expect(prefix.stats).toEqual(stats)
    const header = `${SAMPLE_COLUMNS.join(',')}\n`
    expect(generateSampleRows(0, 7)).toEqual({
      chunks: [header],
      stats: { bytes: header.length, rows: 0, columns: SAMPLE_COLUMNS.length, sourceMix: {}, seed: 7, expectedNotPriced: 0, expectedUnresolved: 0 },
    })
    expect(() => generateSampleRows(-1, 7)).toThrow(RangeError)
  })
})

describe('CSV record counter used to read the benchmark export back', () => {
  function count(text: string, step: number): number {
    const c = createCsvRecordCounter()
    for (let i = 0; i < text.length; i += step) c.push(text.slice(i, i + step))
    return c.finish()
  }

  it('counts records, not lines, at every split point', () => {
    const text = 'a,b,c\r\n1,"x\ny",2\r\n"he said ""hi""",",",\n\n3,"",\r\n"multi\r\nline\r\n"\n4,5,6'
    // Records: header, 1, "he said", 3, "multi", 4. The blank line is not a record.
    const expected = 6
    for (const step of [1, 2, 3, 5, 7, 11, text.length]) expect(count(text, step)).toBe(expected)
    expect(count('', 1)).toBe(0)
    expect(count('\n\r\n', 1)).toBe(0)
    expect(count('only header\n', 4)).toBe(1)
  })

  it('agrees with the sample row count, quoted JSON cells included', async () => {
    const { chunks, stats } = generateSampleRows(1500, 3)
    expect(count(chunks.join(''), 4093)).toBe(stats.rows + 1)
    expect(await countCsvDataRows(new Blob(chunks))).toBe(stats.rows)
  })
})
