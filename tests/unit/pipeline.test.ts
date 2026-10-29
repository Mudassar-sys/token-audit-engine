import { describe, expect, it, vi } from 'vitest'
import type { Adapter, AdapterRow, RawRecord } from '../../src/engine/adapters/types'
import { malformedRow } from '../../src/engine/adapters/types'
import { AuditSummary, type AuditRow, type DetectionResult, type Progress, type VariantId } from '../../src/engine/contracts'
import { sha256Hex } from '../../src/engine/identity'
import { usdToFemto, femtoToExactUsd } from '../../src/engine/money'
import { runImport, type ImportOptions, type RowSink } from '../../src/engine/pipeline'
import { generateSampleChunks } from '../../src/engine/sample'
import { fixtureRecords, fixtureText, runAdapter } from './helpers/otherFixtures'
import { TEST_META, TEST_SNAPSHOT } from './helpers/testSnapshot'

/** Tiny adapter for A-jsonl test records: { model, prompt, cached, completion }. */
const scanned: { facts: number } = { facts: 0 }
const fakeAdapter: Adapter = {
  source: 'A',
  id: 'fake-chat',
  version: '0.0.1',
  variants: ['A-jsonl'],
  label: 'test adapter',
  score: () => ({ score: 1, reason: 'test' }),
  scanFileFacts(sample: RawRecord[]) {
    scanned.facts = sample.length
    return { sampled: sample.length }
  },
  begin(ctx) {
    return {
      push(rec: RawRecord): AdapterRow[] {
        if (rec.kind !== 'json') return [malformedRow(ctx.variant, rec.kind === 'error' ? rec.message : 'not json', rec.kind === 'error' ? rec.raw : null)]
        const v = rec.value as { model: string; prompt: number; cached: number; completion: number; boom?: boolean }
        if (v.boom) throw new Error('kaboom')
        return [
          {
            timestamp: '2026-09-03T00:00:00.000Z',
            variant: ctx.variant,
            provider: 'openai',
            modelLogged: v.model,
            tierStated: 'standard',
            granularity: 'request',
            tokens: {
              uncachedInput: v.prompt - v.cached,
              cacheRead: v.cached,
              cacheWrite: { '5m': 0, '1h': 0, '30m': 0, '12h': 0 },
              output: v.completion,
              reasoning: null,
            },
            notMeasured: [],
            excluded: {},
            reported: null,
            raw: { 'usage.prompt_tokens': v.prompt },
            mapping: [
              'uncachedInput = usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens',
              'cacheRead = usage.prompt_tokens_details.cached_tokens',
              'output = usage.completion_tokens',
            ],
            flags: [],
            unresolvedReason: null,
            counted: true,
            requests: 1,
          },
        ]
      },
      finish() {
        return []
      },
    }
  },
}

/**
 * Adapter that, like the OTLP one, emits every row in finish(). Each row logs 'price' when the
 * pipeline reads it for pricing; sinks log 'write', so tests can see how the two interleave.
 */
const endLog: string[] = []
const endRows: { count: number } = { count: 0 }
const endAdapter: Adapter = {
  source: 'B',
  id: 'fake-end',
  version: '0.0.1',
  variants: ['B-jsonl'],
  label: 'test end adapter',
  score: () => ({ score: 1, reason: 'test' }),
  begin(ctx) {
    const template = fakeAdapter.begin({ ...ctx, variant: 'A-jsonl' }).push({ kind: 'json', value: { model: 'gpt-4o', prompt: 2006, cached: 1920, completion: 300 }, line: 1 })[0]!
    return {
      push: () => [],
      finish() {
        return Array.from({ length: endRows.count }, () => {
          const row: AdapterRow = { ...template, variant: ctx.variant, mapping: [...template.mapping] }
          Object.defineProperty(row, 'modelLogged', {
            enumerable: true,
            get() {
              endLog.push('price')
              return 'gpt-4o'
            },
          })
          return row
        })
      },
    }
  },
}

vi.mock('../../src/engine/adapters/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/engine/adapters/index')>()
  return {
    ...actual,
    adapterForVariant: (v: VariantId) => (v === 'A-jsonl' ? fakeAdapter : v === 'B-jsonl' ? endAdapter : actual.adapterForVariant(v)),
  }
})

const detection: DetectionResult = { variant: 'A-jsonl', confidence: 1, reason: 'test', candidates: [], csvHeaders: null }

class MemorySink implements RowSink {
  rows: AuditRow[] = []
  inFlight = 0
  maxInFlight = 0
  writes = 0
  constructor(
    private readonly delayMs = 0,
    private readonly onWrite?: (n: number) => void,
  ) {}
  async write(rows: AuditRow[]): Promise<void> {
    this.writes++
    this.onWrite?.(this.writes)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
      this.rows.push(...rows)
    } finally {
      this.inFlight--
    }
  }
}

function jsonlFile(n: number, extra: string[] = []): Blob {
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify(i % 3 === 0 ? { model: 'gpt-4o', prompt: 2006, cached: 1920, completion: 300 } : i % 3 === 1 ? { model: 'unlisted-model-x', prompt: 10, cached: 0, completion: 5 } : { model: 'gpt-4o-mini', prompt: 1000, cached: 0, completion: 100 }))
  }
  return new Blob([[...lines, ...extra].join('\n') + '\n'])
}

function options(over: Partial<ImportOptions> & Pick<ImportOptions, 'file' | 'sink'>): ImportOptions {
  return {
    fileName: 'calls.jsonl',
    variant: 'A-jsonl',
    detection,
    overridden: false,
    mapping: null,
    snapshot: TEST_SNAPSHOT,
    snapshotMeta: TEST_META,
    signal: new AbortController().signal,
    onProgress() {},
    ...over,
  }
}

describe('runImport', () => {
  it('runs end to end over a small Blob with a memory sink', async () => {
    const file = jsonlFile(30, ['{broken', JSON.stringify({ boom: true })])
    const sink = new MemorySink()
    const progress: Progress[] = []
    let t = 0
    const summary = await runImport(options({ file, sink, batchSize: 7, onProgress: (p) => progress.push(p), now: () => (t += 50), auditId: 'audit-x' }))

    expect(() => AuditSummary.parse(summary)).not.toThrow()
    expect(summary.auditId).toBe('audit-x')
    expect(summary.fileBytes).toBe(file.size)
    expect(scanned.facts).toBe(32)
    const bytes = new Uint8Array(await file.arrayBuffer())
    expect(summary.inputFileSha256).toBe(sha256Hex(bytes))

    expect(sink.rows.map((r) => r.rowIndex)).toEqual(Array.from({ length: 32 }, (_, i) => i))
    expect(summary.coverage.totalRows).toBe(32)
    expect(summary.coverage.rowsMalformed).toBe(2)
    expect(summary.coverage.rowsNotPriced).toBe(10)
    expect(summary.coverage.rowsPriced).toBe(20)
    expect(summary.totals.partial).toBe(true)

    const gpt4o = sink.rows.find((r) => r.modelLogged === 'gpt-4o')
    expect(gpt4o?.cost.valueUsd).toBe('0.005615')
    expect(sink.rows.find((r) => r.raw && r.flags.includes('malformed') && r.unresolvedReason?.includes('kaboom'))).toBeDefined()

    const sum = sink.rows.reduce((s, r) => s + (r.cost.valueUsd ? usdToFemto(r.cost.valueUsd) : 0n), 0n)
    expect(summary.totals.value.exactUsd).toBe(femtoToExactUsd(sum))

    const last = progress.at(-1)
    expect(last?.bytesRead).toBe(file.size)
    expect(last?.bytesTotal).toBe(file.size)
    expect(last?.rows).toBe(32)
    for (let i = 1; i < progress.length - 1; i++) expect(progress[i]!.elapsedMs - progress[i - 1]!.elapsedMs).toBeGreaterThanOrEqual(100)
  })

  it('never has more than maxPendingWrites sink writes in flight', async () => {
    const sink = new MemorySink(3)
    const summary = await runImport(options({ file: jsonlFile(600), sink, batchSize: 10, maxPendingWrites: 2 }))
    expect(sink.maxInFlight).toBe(2)
    expect(sink.writes).toBe(60)
    expect(sink.rows).toHaveLength(600)
    expect(summary.coverage.totalRows).toBe(600)
    expect(new Set(sink.rows.map((r) => r.rowIndex)).size).toBe(600)
  })

  it('a write error rejects the import', async () => {
    const sink: RowSink = { write: () => Promise.reject(new Error('disk full')) }
    await expect(runImport(options({ file: jsonlFile(50), sink, batchSize: 5 }))).rejects.toThrow('disk full')
  })

  it('abort mid-way rejects with AbortError after in-flight writes settle', async () => {
    const ac = new AbortController()
    const sink = new MemorySink(5, (n) => {
      if (n === 3) ac.abort()
    })
    const p = runImport(options({ file: jsonlFile(5000), sink, batchSize: 10, maxPendingWrites: 2, signal: ac.signal }))
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(sink.inFlight).toBe(0)
    expect(sink.writes).toBeLessThan(10)
    expect(sink.rows.length).toBeLessThan(5000)
  })

  it('an already aborted signal rejects at once', async () => {
    const ac = new AbortController()
    ac.abort()
    const sink = new MemorySink()
    await expect(runImport(options({ file: jsonlFile(5), sink, signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    expect(sink.writes).toBe(0)
  })

  it('prices and writes rows emitted at the end one batch at a time', async () => {
    endLog.length = 0
    endRows.count = 1000
    const sink = new MemorySink(0, () => endLog.push('write'))
    const summary = await runImport(options({ file: jsonlFile(3), sink, variant: 'B-jsonl', detection: { ...detection, variant: 'B-jsonl' }, batchSize: 100 }))
    expect(summary.coverage.totalRows).toBe(1000)
    expect(sink.rows.map((r) => r.rowIndex)).toEqual(Array.from({ length: 1000 }, (_, i) => i))
    expect(sink.writes).toBe(10)
    // No more than one batch is priced before it goes to the write queue.
    expect(endLog.indexOf('write')).toBe(100)
    let run = 0
    for (const e of endLog) {
      run = e === 'price' ? run + 1 : 0
      expect(run).toBeLessThanOrEqual(100)
    }
  })

  it('a cancel is received while rows emitted at the end are being priced and written', async () => {
    endRows.count = 60_000
    const ac = new AbortController()
    const sink = new MemorySink(0, (n) => {
      if (n === 1) setTimeout(() => ac.abort(), 0)
    })
    const p = runImport(options({ file: jsonlFile(3), sink, variant: 'B-jsonl', detection: { ...detection, variant: 'B-jsonl' }, batchSize: 500, signal: ac.signal }))
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(sink.rows.length).toBeLessThan(60_000)
  })

  it('imports a single-document OTLP export span by span with the real adapter', async () => {
    const sink = new MemorySink()
    const text = fixtureText('g-otel-spans.json')
    const file = new Blob([text])
    const summary = await runImport(options({ file, sink, fileName: 'g-otel-spans.json', variant: 'G-otlp', detection: { ...detection, variant: 'G-otlp' }, batchSize: 2 }))
    const expected = runAdapter('G-otlp', fixtureRecords('g-otel-spans.json', 'G-otlp'))
    expect(expected.length).toBeGreaterThan(0)
    const view = (r: AdapterRow) => ({ tokens: r.tokens, raw: r.raw, counted: r.counted, modelLogged: r.modelLogged, timestamp: r.timestamp })
    expect(sink.rows.map(view)).toEqual(expected.map(view))
    // Pricing may add its own flags; the adapter's flags are all kept.
    sink.rows.forEach((r, i) => expect(r.flags).toEqual(expect.arrayContaining(expected[i]!.flags)))
    expect(summary.coverage.totalRows).toBe(expected.length)
    expect(summary.inputFileSha256).toBe(sha256Hex(new Uint8Array(await file.arrayBuffer())))
  })

  it('imports a generated LiteLLM spend log CSV with the real adapter and multibyte-safe chunking', async () => {
    const it = generateSampleChunks(300_000, 9)
    const parts: string[] = []
    let r = it.next()
    while (!r.done) {
      parts.push(r.value)
      r = it.next()
    }
    const stats = r.value
    const file = new Blob(parts)
    const sink = new MemorySink()
    const summary = await runImport(
      options({
        file,
        sink,
        fileName: 'sample.csv',
        variant: 'F-csv',
        detection: { ...detection, variant: 'F-csv' },
        csvChunkSize: 64 * 1024,
      }),
    )
    expect(() => AuditSummary.parse(summary)).not.toThrow()
    expect(summary.coverage.totalRows).toBe(stats.rows)
    expect(summary.coverage.rowsMalformed).toBe(0)
    expect(summary.coverage.rowsNotPriced).toBeGreaterThan(0)
    expect(summary.coverage.rowsPriced).toBeGreaterThan(stats.rows * 0.9)
    expect(sink.rows).toHaveLength(stats.rows)
    expect(summary.aggregates.byProvider.map((b) => b.key).sort()).toEqual(Object.keys(stats.sourceMix).sort())
  })
})
