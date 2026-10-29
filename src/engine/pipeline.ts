import { adapterForVariant } from './adapters/index'
import { malformedRow, type AdapterRow, type RawRecord } from './adapters/types'
import type {
  AuditRow,
  AuditSummary,
  CustomCsvMapping,
  DetectionResult,
  FrozenSnapshot,
  PricingSnapshot,
  Progress,
  VariantId,
} from './contracts'
import { Aggregator, DEFAULT_AGGREGATE_KEY_CAP } from './aggregate'
import { createIncrementalSha256 } from './identity'
import { createPricingEngine, type PriceOverrideInput } from './pricing'
import { abortError, sampleRecordsFromBlob, streamFormatForVariant, streamRecords } from './stream/index'
import { raceAbort } from './stream/reader'

/** Rows of the file-fact scan before the main pass. */
export const FILE_FACT_SAMPLE = 5000
export const PROGRESS_INTERVAL_MS = 100

export interface RowSink {
  write(rows: AuditRow[]): Promise<void>
}

export interface ImportOptions {
  file: Blob
  fileName: string
  variant: VariantId
  detection: DetectionResult
  overridden: boolean
  mapping: CustomCsvMapping | null
  snapshot: PricingSnapshot
  snapshotMeta: FrozenSnapshot & { sourceUrl: string }
  signal: AbortSignal
  sink: RowSink
  onProgress(p: Progress): void
  /** Rows per sink.write call. Default 2000. */
  batchSize?: number
  /** Sink writes in flight at most. Default 4. */
  maxPendingWrites?: number
  /** Distinct keys per aggregate dimension before '(overflow)'. Default 5000. */
  aggregateKeyCap?: number
  /** Id of this audit. Default: a random UUID. */
  auditId?: string
  /** Optional rate overrides (part of the calculation identity). */
  priceOverrides?: PriceOverrideInput[]
  /** Display decimals for summary amounts. Default 6. */
  displayDecimals?: number
  /** Test hook: CSV chunk size passed to the stream reader. */
  csvChunkSize?: number
  now?: () => number
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `audit-${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`
}

/**
 * Bounded write queue: sink writes start without being awaited, and at most
 * `max` are in flight. reserve() waits for a free slot, which is how the parser
 * gets paused when storage falls behind.
 */
export class WriteQueue {
  private readonly inFlight = new Set<Promise<void>>()
  private error: unknown = null
  /** Highest number of writes seen in flight at once. */
  peak = 0

  constructor(
    private readonly sink: RowSink,
    private readonly max: number,
  ) {
    if (!Number.isInteger(max) || max < 1) throw new Error(`maxPendingWrites must be a positive integer, got ${max}`)
  }

  get size(): number {
    return this.inFlight.size
  }

  private check(): void {
    if (this.error !== null) throw this.error
  }

  /** Start a write once a slot is free. Resolves when the write has started, not finished. */
  async push(rows: AuditRow[], signal: AbortSignal): Promise<void> {
    this.check()
    while (this.inFlight.size >= this.max) {
      await raceAbort(Promise.race(this.inFlight), signal)
      this.check()
    }
    const p: Promise<void> = this.sink.write(rows).then(
      () => {
        this.inFlight.delete(p)
      },
      (err: unknown) => {
        this.inFlight.delete(p)
        this.error ??= err
      },
    )
    this.inFlight.add(p)
    this.peak = Math.max(this.peak, this.inFlight.size)
  }

  /** Wait for every write in flight. Throws the first write error. */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.race(this.inFlight)
    this.check()
  }

  /** Wait for every write in flight to settle, ignoring errors (used on cancel). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }
}

/**
 * Run one import: stream the file, normalize with the variant's adapter, price each
 * row against the frozen snapshot, aggregate, and write rows to the sink in batches.
 * Rejects with an AbortError when the signal aborts, after in-flight writes settle.
 */
export async function runImport(o: ImportOptions): Promise<AuditSummary> {
  const now = o.now ?? (() => Date.now())
  const started = now()
  const signal = o.signal
  if (signal.aborted) throw abortError()

  const batchSize = Math.max(1, o.batchSize ?? 2000)
  const queue = new WriteQueue(o.sink, o.maxPendingWrites ?? 4)
  const format = streamFormatForVariant(o.variant)
  const adapter = adapterForVariant(o.variant)

  try {
    let fileFacts: Record<string, unknown> = {}
    if (adapter.scanFileFacts) {
      const sample = await sampleRecordsFromBlob(o.file, format, FILE_FACT_SAMPLE, signal)
      fileFacts = adapter.scanFileFacts(sample)
    }
    if (signal.aborted) throw abortError()

    const run = adapter.begin({ variant: o.variant, mapping: o.mapping, fileFacts })
    const pricing = createPricingEngine(o.snapshot, o.snapshotMeta, o.priceOverrides ?? [])
    const agg = new Aggregator(o.aggregateKeyCap ?? DEFAULT_AGGREGATE_KEY_CAP, o.displayDecimals ?? 6)
    const hasher = createIncrementalSha256()

    let rowIndex = 0
    let bytesRead = 0
    let lastProgress = Number.NEGATIVE_INFINITY
    let buffer: AuditRow[] = []

    const progress = (force: boolean) => {
      const t = now()
      if (!force && t - lastProgress < PROGRESS_INTERVAL_MS) return
      lastProgress = t
      const elapsedMs = Math.max(0, t - started)
      o.onProgress({
        bytesRead,
        bytesTotal: o.file.size,
        rows: rowIndex,
        rowsPerSecond: elapsedMs > 0 ? (rowIndex * 1000) / elapsedMs : 0,
        elapsedMs,
      })
    }

    const take = (rows: AdapterRow[]) => {
      for (const r of rows) {
        const row = pricing.price({ ...r, rowIndex: rowIndex++ })
        agg.add(row)
        buffer.push(row)
      }
    }

    const pushRecord = (rec: RawRecord) => {
      let rows: AdapterRow[]
      try {
        rows = run.push(rec)
      } catch (err) {
        rows = [malformedRow(o.variant, `adapter error: ${err instanceof Error ? err.message : String(err)}`, rec)]
      }
      take(rows)
    }

    const flushFull = async () => {
      while (buffer.length >= batchSize) {
        const batch = buffer.slice(0, batchSize)
        buffer = buffer.slice(batchSize)
        await queue.push(batch, signal)
      }
    }

    await streamRecords(
      o.file,
      format,
      {
        signal,
        onBytes(n) {
          bytesRead = n
          progress(false)
        },
        onChunk(bytes) {
          hasher.update(bytes)
        },
        csvChunkSize: o.csvChunkSize,
      },
      async (records) => {
        for (const rec of records) {
          pushRecord(rec)
          if (buffer.length >= batchSize) await flushFull()
        }
        if (signal.aborted) throw abortError()
      },
    )

    take(run.finish())
    await flushFull()
    if (buffer.length) {
      const rest = buffer
      buffer = []
      await queue.push(rest, signal)
    }
    await queue.drain()
    if (signal.aborted) throw abortError()
    progress(true)

    const elapsedMs = Math.max(0, now() - started)
    const sums = agg.summary()
    return {
      auditId: o.auditId ?? randomId(),
      fileName: o.fileName,
      fileBytes: o.file.size,
      variant: o.variant,
      detection: o.detection,
      overridden: o.overridden,
      inputFileSha256: hasher.digestHex(),
      snapshot: o.snapshotMeta,
      ...sums,
      mapping: o.mapping,
      elapsedMs,
      rowsPerSecond: elapsedMs > 0 ? (rowIndex * 1000) / elapsedMs : 0,
    }
  } catch (err) {
    await queue.settle()
    throw err
  }
}
