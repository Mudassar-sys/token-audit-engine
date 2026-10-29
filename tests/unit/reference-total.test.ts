import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Papa from 'papaparse'
import { describe, expect, it } from 'vitest'
import { PricingSnapshot, type AuditRow, type PricingModelEntry } from '../../src/engine/contracts'
import { detectFromSample } from '../../src/engine/detect'
import { runImport } from '../../src/engine/pipeline'
import { generateSampleRows } from '../../src/engine/sample'

/**
 * The engine total over a seeded sample, checked against a reference computed here from the
 * CSV text and the snapshot's rate strings. The reference uses its own decimal arithmetic and
 * never imports the engine's pricing, money or aggregation code.
 */

const ROWS = 20_000
/** The benchmark's seed, so this checks the same kind of rows the benchmark imports. */
const SEED = 20261029
const SNAPSHOT_FILE = '2026-10-29-aa992e3f.json'

const snapshotBytes = readFileSync(join(process.cwd(), 'public', 'pricing', SNAPSHOT_FILE))
const snapshot = PricingSnapshot.parse(JSON.parse(snapshotBytes.toString('utf8')))
const snapshotMeta = {
  file: SNAPSHOT_FILE,
  date: snapshot.date,
  sha256: createHash('sha256').update(snapshotBytes).digest('hex'),
  commit: snapshot.source.commit,
  sourceUrl: snapshot.source.url,
}

// ---- Plain decimal arithmetic: value = n / 10^scale, exact. ----

interface Dec {
  n: bigint
  scale: number
}

const ZERO: Dec = { n: 0n, scale: 0 }

/** Parse decimal text, with an optional exponent ("1.25e-06"). */
function dec(text: string): Dec {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim())
  if (!m) throw new Error(`not a decimal: ${text}`)
  const frac = m[3] ?? ''
  let n = BigInt(`${m[2]}${frac}`)
  if (m[1] === '-') n = -n
  let scale = frac.length - Number(m[4] ?? '0')
  if (scale < 0) {
    n *= 10n ** BigInt(-scale)
    scale = 0
  }
  return { n, scale }
}

function add(a: Dec, b: Dec): Dec {
  const scale = Math.max(a.scale, b.scale)
  return { n: a.n * 10n ** BigInt(scale - a.scale) + b.n * 10n ** BigInt(scale - b.scale), scale }
}

function times(a: Dec, k: number): Dec {
  return { n: a.n * BigInt(k), scale: a.scale }
}

function isZero(a: Dec): boolean {
  return a.n === 0n
}

/** Canonical text: no trailing fractional zeros, "0" for zero. */
function text(a: Dec): string {
  const neg = a.n < 0n
  let digits = (neg ? -a.n : a.n).toString()
  if (a.scale > 0) {
    digits = digits.padStart(a.scale + 1, '0')
    const int = digits.slice(0, digits.length - a.scale)
    const frac = digits.slice(digits.length - a.scale).replace(/0+$/, '')
    digits = frac ? `${int}.${frac}` : int
  }
  return digits === '0' ? '0' : `${neg ? '-' : ''}${digits}`
}

function canonical(decimalText: string): string {
  return text(dec(decimalText))
}

// ---- Reference pricing of one LiteLLM spend log row. ----

type Outcome = { kind: 'Not priced'; value: null } | { kind: 'Unresolved'; value: null } | { kind: 'Estimated'; value: Dec }

function int(v: unknown): number {
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`not a token count: ${String(v)}`)
  return n
}

/**
 * Rules, written from the LiteLLM spend log format and the snapshot keys:
 * - the model is looked up by its exact id; an unlisted model is Not priced;
 * - prompt_tokens includes cache reads and writes (LiteLLM's normalized usage), so
 *   uncached input = prompt_tokens - cache read - cache write;
 * - unsplit cache writes are 5 minute writes for anthropic and 30 minute writes for openai,
 *   and both are the base cache_creation_input_token_cost key;
 * - when the model has a reasoning rate and reasoning tokens are logged, output is split into
 *   (completion - reasoning) at the output rate plus reasoning at the reasoning rate;
 * - a class with tokens needs its rate, else the row is Not priced; a class with 0 tokens needs none;
 * - spend 0 with a non-zero estimate is Unresolved; otherwise the value is the estimate.
 */
function referenceRow(r: Record<string, string>): Outcome {
  const entry: PricingModelEntry | undefined = snapshot.models[r.model ?? '']
  if (!entry) return { kind: 'Not priced', value: null }
  const usage = (JSON.parse(r.metadata ?? '{}') as { additional_usage_values?: Record<string, unknown> }).additional_usage_values ?? {}
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined
  const prompt = int(r.prompt_tokens)
  const completion = int(r.completion_tokens)
  const read = int(usage.cache_read_input_tokens ?? promptDetails.cached_tokens ?? 0)
  const write = int(usage.cache_creation_input_tokens ?? promptDetails.cache_write_tokens ?? 0)
  const reasoning = completionDetails ? int(completionDetails.reasoning_tokens) : null

  // The sample stays below every long-context threshold; a row above one would need other keys.
  for (const key of Object.keys(entry.rates)) {
    const m = /_above_(\d+)k_tokens/.exec(key)
    if (m && prompt > Number(m[1]) * 1000) throw new Error(`row above a long-context threshold: ${r.request_id}`)
  }
  if (write > 0 && !['anthropic', 'openai'].includes(r.custom_llm_provider ?? '')) {
    throw new Error(`cache writes without a documented duration: ${r.request_id}`)
  }

  const lines: [number, string][] = [
    [prompt - read - write, 'input_cost_per_token'],
    [read, 'cache_read_input_token_cost'],
    [write, 'cache_creation_input_token_cost'],
  ]
  if (entry.rates.output_cost_per_reasoning_token !== undefined && reasoning !== null) {
    lines.push([completion - reasoning, 'output_cost_per_token'], [reasoning, 'output_cost_per_reasoning_token'])
  } else {
    lines.push([completion, 'output_cost_per_token'])
  }
  let estimate = ZERO
  for (const [tokens, key] of lines) {
    if (tokens < 0) throw new Error(`negative ${key} tokens: ${r.request_id}`)
    if (tokens === 0) continue
    const rate = entry.rates[key]
    if (rate === undefined) return { kind: 'Not priced', value: null }
    estimate = add(estimate, times(dec(rate), tokens))
  }
  if (isZero(dec(r.spend ?? '')) && !isZero(estimate)) return { kind: 'Unresolved', value: null }
  return { kind: 'Estimated', value: estimate }
}

describe('engine total against an independent reference', () => {
  it(`prices a seeded ${ROWS.toLocaleString('en-US')}-row sample to the exact reference total`, async () => {
    const { chunks, stats } = generateSampleRows(ROWS, SEED)
    const csv = chunks.join('')
    const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: 'greedy' })
    expect(parsed.errors).toEqual([])
    expect(parsed.data).toHaveLength(ROWS)

    let total = ZERO
    let notPriced = 0
    let unresolved = 0
    const expected = parsed.data.map((r) => {
      const o = referenceRow(r)
      if (o.kind === 'Not priced') notPriced++
      else if (o.kind === 'Unresolved') unresolved++
      else total = add(total, o.value)
      return o
    })
    // The generator's own count of the rows it wrote to be Not priced and Unresolved agrees.
    expect(notPriced).toBe(stats.expectedNotPriced)
    expect(unresolved).toBe(stats.expectedUnresolved)
    expect(notPriced).toBeGreaterThan(0)
    expect(unresolved).toBeGreaterThan(0)
    expect(isZero(total)).toBe(false)
    // Unlisted models with spend 0 are in the sample, and they stay Not priced, not Unresolved.
    const unlistedZero = parsed.data.filter((r) => snapshot.models[r.model ?? ''] === undefined && isZero(dec(r.spend ?? '')))
    expect(unlistedZero.length).toBeGreaterThan(0)

    const fileName = 'sample-litellm-spend.csv'
    const detection = detectFromSample(csv.slice(0, 64 * 1024), fileName)
    expect(detection.variant).toBe('F-csv')
    const rows: AuditRow[] = []
    const summary = await runImport({
      file: new Blob(chunks, { type: 'text/csv' }),
      fileName,
      variant: 'F-csv',
      detection,
      overridden: false,
      mapping: null,
      snapshot,
      snapshotMeta,
      signal: new AbortController().signal,
      sink: {
        write: async (batch) => {
          for (const row of batch) rows.push(row)
        },
      },
      onProgress() {},
    })

    // Row by row first, so a difference names the row.
    expect(rows).toHaveLength(ROWS)
    rows.sort((a, b) => a.rowIndex - b.rowIndex)
    for (let i = 0; i < ROWS; i++) {
      const got = rows[i]!
      const want = expected[i]!
      const gotValue = got.cost.valueUsd === null ? null : canonical(got.cost.valueUsd)
      const wantValue = want.value === null ? null : text(want.value)
      if (got.cost.label.kind !== want.kind || gotValue !== wantValue) {
        expect({ row: i, request: got.raw.request_id, kind: got.cost.label.kind, value: gotValue }).toEqual({
          row: i,
          request: got.raw.request_id,
          kind: want.kind,
          value: wantValue,
        })
      }
    }

    expect(summary.coverage.totalRows).toBe(ROWS)
    expect(summary.coverage.rowsMalformed).toBe(0)
    expect(summary.coverage.rowsNotPriced).toBe(notPriced)
    expect(summary.coverage.rowsUnresolved).toBe(unresolved)
    expect(summary.coverage.rowsPriced).toBe(ROWS - notPriced - unresolved)
    expect(canonical(summary.totals.value.exactUsd)).toBe(text(total))
    expect(canonical(summary.totals.estimated.exactUsd)).toBe(text(total))
    expect(canonical(summary.totals.measuredCharge.exactUsd)).toBe('0')
    expect(summary.totals.partial).toBe(true)
  }, 180_000)
})
