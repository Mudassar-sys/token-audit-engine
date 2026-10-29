// Must stay the first import: zod reads this setting when the schemas are built.
import './zodJitless'
import type { AuditRow, AuditSummary, NormalizedUsageRow, WorkerRequest, WorkerResponse } from '../engine/contracts'
import { runImport, type RowSink } from '../engine/pipeline'
import { detectFromSample } from '../engine/detect'
import { adapterForVariant } from '../engine/adapters'
import { CSV_HEADER, auditRowToCsvLine } from '../engine/export'
import { createIncrementalSha256 } from '../engine/identity'
import { generateSampleChunks } from '../engine/sample'
import { createScenario } from '../engine/savings'
import { streamRecords } from '../engine/stream'
import {
  StoreQuotaError,
  clearAll,
  countRows,
  deleteAudit,
  getRow,
  getRows,
  isQuotaError,
  iterateRows,
  listAuditIds,
  putAudit,
  putRows,
} from './store'
import { blobSink, streamSink, utf8Length, type ExportSink, type ExportTarget } from './csvExport'

/**
 * Engine worker. Every import, read and export runs here, off the main thread.
 * Messages travel in an envelope { id, request } / { id, response } so the client can match replies.
 */

export interface RequestEnvelope { id: number; request: WorkerRequest }
export interface ResponseEnvelope { id: number; response: WorkerResponse }

/** The parts of the worker global scope this module uses. */
interface WorkerScope {
  postMessage(message: ResponseEnvelope): void
  addEventListener(type: 'message', listener: (event: MessageEvent<RequestEnvelope>) => void): void
  navigator: { storage?: { estimate?(): Promise<{ usage?: number; quota?: number }> } }
}

const scope = self as unknown as WorkerScope

const SAMPLE_BYTES = 64 * 1024
const CSV_EXPORT_BATCH = 5000
/** Rows read from IndexedDB per scenario step. */
export const SCENARIO_BATCH = 2000
const STORAGE_FACTOR = 3
const PREVIEW_ROWS = 20
/** The preview stops after this many records even when fewer than 20 rows mapped. */
const PREVIEW_MAX_RECORDS = 1000

export const EXPORT_STOPPED_BY_IMPORT = 'The CSV export stopped because a new import started. No complete file was saved. A file you chose may be empty or partial, so export again.'
export const EXPORT_STOPPED_BY_CLEAR = 'The CSV export stopped because local data was cleared. No complete file was saved. A file you chose may be empty or partial, so export again.'
export const SCENARIO_STOPPED_BY_IMPORT = 'The savings model stopped because a new import started.'
export const SCENARIO_STOPPED_BY_CLEAR = 'The savings model stopped because local data was cleared.'
export const SCENARIO_ALREADY_RUNNING = 'A savings model is already running. Wait for it to finish.'

interface RunningImport {
  id: number
  auditId: string
  controller: AbortController
  sink: TrackingSink
  /** Set by the first cancel request. Every cancel request id gets one reply. */
  cancel: { ids: number[]; startedAt: number } | null
}

/** The audit that is open for reads and exports, with the row count the import stored. */
interface CurrentAudit {
  auditId: string
  totalRows: number
}

/** A CSV export or a scenario in progress. stopReason is set when an import or a clear starts during it. */
interface ReadJob {
  auditId: string
  stopReason: string | null
}

let running: RunningImport | null = null
let importFinished: Promise<void> | null = null
let current: CurrentAudit | null = null
const exportJobs = new Set<ReadJob>()
/** One scenario at a time. */
let scenarioJob: ReadJob | null = null

function post(id: number, response: WorkerResponse): void {
  const env: ResponseEnvelope = { id, response }
  scope.postMessage(env)
}

function errorResponse(code: 'quota' | 'parse' | 'unsupported' | 'internal', message: string): WorkerResponse {
  return { type: 'error', code, message }
}

/** Row sink that writes batches to IndexedDB and tracks writes still in flight. */
class TrackingSink implements RowSink {
  private readonly pending = new Set<Promise<void>>()
  private stopped = false
  firstError: unknown = null

  constructor(private readonly auditId: string) {}

  write(rows: AuditRow[]): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const p = putRows(this.auditId, rows).catch((err: unknown) => {
      if (this.firstError === null) this.firstError = err
      throw err
    })
    const tracked = p.finally(() => this.pending.delete(tracked))
    tracked.catch(() => undefined)
    this.pending.add(tracked)
    return p
  }

  /** Accept no more writes (after a cancel or an error). */
  stop(): void {
    this.stopped = true
  }

  /** Wait until every write that started has settled. */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }
}

function newAuditId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `audit-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} bytes`
}

async function storageEstimate(): Promise<{ usage: number | null; quota: number | null }> {
  try {
    const est = await scope.navigator.storage?.estimate?.()
    return { usage: est?.usage ?? null, quota: est?.quota ?? null }
  } catch {
    return { usage: null, quota: null }
  }
}

async function readSampleText(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.slice(0, SAMPLE_BYTES).arrayBuffer())
  // stream: true keeps a multibyte character cut at the slice end out of the text.
  return new TextDecoder('utf-8').decode(bytes, { stream: true })
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError'
}

function codeForError(err: unknown): 'parse' | 'unsupported' | 'internal' {
  const name = (err as { name?: unknown } | null)?.name
  if (name === 'SyntaxError' || name === 'ParseError') return 'parse'
  if (name === 'UnsupportedError') return 'unsupported'
  return 'internal'
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

async function deleteQuietly(auditId: string): Promise<boolean> {
  try {
    await deleteAudit(auditId)
    return true
  } catch {
    return false
  }
}

function throwIfAborted(controller: AbortController): void {
  if (controller.signal.aborted) throw new DOMException('Import cancelled', 'AbortError')
}

/** Reply to every cancel request of this import that has no reply yet. */
function answerCancels(run: RunningImport, res: WorkerResponse): void {
  const ids = run.cancel?.ids.splice(0) ?? []
  for (const cancelId of ids) post(cancelId, res)
}

/** Stop every CSV export in progress, so none can finish with rows missing. */
function stopExports(reason: string): void {
  for (const job of exportJobs) job.stopReason ??= reason
}

/** Stop the running scenario, so none can finish on rows that are being replaced. */
function stopScenario(reason: string): void {
  if (scenarioJob) scenarioJob.stopReason ??= reason
}

async function handleImport(id: number, req: Extract<WorkerRequest, { type: 'import' }>): Promise<void> {
  if (running) {
    post(id, errorResponse('internal', 'An import is already running. Cancel it first.'))
    return
  }
  // This import deletes the open audit, so an export or a scenario of it can no longer finish.
  stopExports(EXPORT_STOPPED_BY_IMPORT)
  stopScenario(SCENARIO_STOPPED_BY_IMPORT)
  const file = req.file as Blob
  const auditId = newAuditId()
  const controller = new AbortController()
  const sink = new TrackingSink(auditId)
  const run: RunningImport = { id, auditId, controller, sink, cancel: null }
  running = run
  let partialRowsDeleted = false

  try {
    const { usage, quota } = await storageEstimate()
    throwIfAborted(controller)
    if (quota !== null) {
      const free = Math.max(0, quota - (usage ?? 0))
      const needed = file.size * STORAGE_FACTOR
      if (needed > free) {
        post(id, errorResponse('quota', `This file needs ${formatBytes(needed)} of local storage and ${formatBytes(free)} is free. Clear local data or use a smaller file.`))
        return
      }
    }

    // One audit at a time: earlier audits are removed before a new import starts.
    for (const old of await listAuditIds()) await deleteAudit(old)
    current = null
    await putAudit({ auditId, status: 'importing', fileName: req.fileName, startedAt: new Date().toISOString(), summary: null })
    throwIfAborted(controller)

    const result = await runImport({
      file,
      fileName: req.fileName,
      variant: req.variant,
      detection: req.detection,
      overridden: req.overridden,
      mapping: req.mapping,
      snapshot: req.snapshot,
      snapshotMeta: req.snapshotMeta,
      signal: controller.signal,
      sink,
      auditId,
      onProgress: (progress) => post(id, { type: 'progress', progress }),
    })
    throwIfAborted(controller)
    await sink.drain()
    if (sink.firstError) throw sink.firstError
    const summary: AuditSummary = { ...result, auditId }
    await putAudit({ auditId, status: 'done', fileName: req.fileName, startedAt: new Date().toISOString(), summary })
    // A cancel that arrived while the last writes settled still wins: the visitor asked to stop.
    throwIfAborted(controller)
    current = { auditId, totalRows: summary.coverage.totalRows }
    post(id, { type: 'done', summary })
  } catch (err) {
    sink.stop()
    controller.abort()
    await sink.drain()
    const quotaHit = isQuotaError(err) || isQuotaError(sink.firstError)
    if (run.cancel && !quotaHit) {
      const cancelMs = performance.now() - run.cancel.startedAt
      const deleteStart = performance.now()
      partialRowsDeleted = await deleteQuietly(auditId)
      const deleteMs = performance.now() - deleteStart
      const res: WorkerResponse = { type: 'cancelled', cancelMs, deleteMs, partialRowsDeleted, auditId }
      post(id, res)
      answerCancels(run, res)
    } else if (quotaHit) {
      const deleteStart = performance.now()
      partialRowsDeleted = await deleteQuietly(auditId)
      const deleteMs = performance.now() - deleteStart
      const note = partialRowsDeleted ? ' Partial rows were deleted.' : ' Partial rows could not be deleted. Use Clear local data.'
      post(id, errorResponse('quota', new StoreQuotaError().message + note))
      if (run.cancel) answerCancels(run, { type: 'cancelled', cancelMs: performance.now() - run.cancel.startedAt, deleteMs, partialRowsDeleted, auditId })
    } else if (isAbortError(err)) {
      const deleteStart = performance.now()
      partialRowsDeleted = await deleteQuietly(auditId)
      post(id, { type: 'cancelled', cancelMs: 0, deleteMs: performance.now() - deleteStart, partialRowsDeleted, auditId })
    } else {
      partialRowsDeleted = await deleteQuietly(auditId)
      post(id, errorResponse(codeForError(err), messageOf(err)))
    }
  } finally {
    // A cancel that came in after the outcome was decided still gets a reply.
    if (run.cancel && run.cancel.ids.length > 0) {
      answerCancels(run, { type: 'cancelled', cancelMs: performance.now() - run.cancel.startedAt, deleteMs: 0, partialRowsDeleted, auditId })
    }
    if (running === run) running = null
  }
}

function handleCancel(id: number): void {
  const run = running
  if (!run) {
    post(id, { type: 'cancelled', cancelMs: 0, deleteMs: 0, partialRowsDeleted: false, auditId: null })
    return
  }
  if (run.cancel) {
    // A repeated cancel: reply together with the first one.
    run.cancel.ids.push(id)
    return
  }
  run.cancel = { ids: [id], startedAt: performance.now() }
  run.sink.stop()
  run.controller.abort()
}

async function handleRows(id: number, offset: number, limit: number): Promise<void> {
  const rows = current ? await getRows(current.auditId, offset, Math.min(Math.max(0, limit), 1000)) : []
  post(id, { type: 'rows', offset, rows })
}

async function handleRow(id: number, rowIndex: number): Promise<void> {
  post(id, { type: 'row', row: current ? await getRow(current.auditId, rowIndex) : null })
}

class ExportStopped extends Error {}

async function handleExportCsv(id: number, target: ExportTarget | null): Promise<void> {
  // The audit is fixed when the export starts. An import or clear during the export stops it.
  const audit = current
  if (!audit) {
    post(id, errorResponse('internal', 'There is no audit to export yet.'))
    return
  }
  const started = performance.now()
  const job: ReadJob = { auditId: audit.auditId, stopReason: null }
  exportJobs.add(job)
  let sink: ExportSink | null = null
  try {
    sink = target ? await streamSink(target) : blobSink()
    const out = sink
    let bytes = 0
    let rows = 0
    await out.write(CSV_HEADER)
    bytes += utf8Length(CSV_HEADER)
    const total = await iterateRows(audit.auditId, CSV_EXPORT_BATCH, async (batch) => {
      if (job.stopReason) throw new ExportStopped(job.stopReason)
      if (target) {
        // Stream path: one write per batch.
        const text = batch.map(auditRowToCsvLine).join('')
        await out.write(text)
        bytes += utf8Length(text)
      } else {
        // Blob path: line by line into the buffer, so every part but the last is just over 8 MiB.
        for (const row of batch) {
          const line = auditRowToCsvLine(row)
          await out.write(line)
          bytes += utf8Length(line)
        }
      }
      rows += batch.length
      post(id, { type: 'exportProgress', rows, bytes })
    })
    if (job.stopReason) throw new ExportStopped(job.stopReason)
    if (total !== audit.totalRows) {
      throw new ExportStopped(`The CSV export read ${total} of ${audit.totalRows} rows, so no complete file was saved. A file you chose may be empty or partial, so export again.`)
    }
    const blob = await out.finish()
    sink = null
    post(id, { type: 'csv', blob, rows: total, bytes, path: target ? 'stream' : 'blob', ms: performance.now() - started })
  } catch (err) {
    await sink?.abort()
    if (err instanceof ExportStopped) post(id, errorResponse('internal', err.message))
    else post(id, isQuotaError(err) ? errorResponse('quota', `The CSV export failed: ${messageOf(err)}`) : errorResponse(codeForError(err), `The CSV export failed: ${messageOf(err)}`))
  } finally {
    exportJobs.delete(job)
  }
}

class ScenarioStopped extends Error {}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Reprice every stored row of the open audit under the scenario, 2,000 rows at a time. */
async function handleScenario(id: number, req: Extract<WorkerRequest, { type: 'scenario' }>): Promise<void> {
  const audit = current
  if (!audit) {
    post(id, errorResponse('internal', 'There is no audit to model yet.'))
    return
  }
  if (scenarioJob) {
    post(id, errorResponse('internal', SCENARIO_ALREADY_RUNNING))
    return
  }
  const job: ReadJob = { auditId: audit.auditId, stopReason: null }
  scenarioJob = job
  const started = performance.now()
  try {
    const run = createScenario(req.request)
    let rowsDone = 0
    const total = await iterateRows(audit.auditId, SCENARIO_BATCH, async (batch) => {
      if (job.stopReason) throw new ScenarioStopped(job.stopReason)
      run.add(batch)
      rowsDone += batch.length
      post(id, { type: 'scenarioProgress', rowsDone, rowsTotal: audit.totalRows })
      // Let import, clear and other messages in between batches.
      await nextTurn()
    })
    if (job.stopReason) throw new ScenarioStopped(job.stopReason)
    if (total !== audit.totalRows) {
      throw new ScenarioStopped(`The savings model read ${total} of ${audit.totalRows} rows. Run it again.`)
    }
    post(id, { type: 'scenario', result: run.result(performance.now() - started) })
  } catch (err) {
    if (!(err instanceof ScenarioStopped)) throw err
    post(id, errorResponse('internal', err.message))
  } finally {
    if (scenarioJob === job) scenarioJob = null
  }
}

/** Map the first 20 rows of a custom CSV. Reads records until 20 rows are mapped, whatever the row size. */
async function handlePreview(id: number, req: Extract<WorkerRequest, { type: 'preview' }>): Promise<void> {
  const run = adapterForVariant('H-csv').begin({ variant: 'H-csv', mapping: req.mapping, fileFacts: {} })
  const rows: NormalizedUsageRow[] = []
  const errors: string[] = []
  const stop = new AbortController()
  let records = 0
  const enough = () => rows.length >= PREVIEW_ROWS || records >= PREVIEW_MAX_RECORDS
  try {
    await streamRecords(req.file as Blob, 'csv', { signal: stop.signal, onBytes() {}, onChunk() {} }, (batch) => {
      for (const record of batch) {
        if (enough()) break
        records++
        if (record.kind === 'error') errors.push(`Line ${record.line ?? '?'}: ${record.message}`)
        for (const row of run.push(record)) {
          if (rows.length >= PREVIEW_ROWS) break
          const full: NormalizedUsageRow = { ...row, rowIndex: rows.length }
          rows.push(full)
          if (full.unresolvedReason) errors.push(`Row ${full.rowIndex + 1}: ${full.unresolvedReason}`)
        }
      }
      if (enough()) stop.abort()
    })
  } catch (err) {
    if (!isAbortError(err)) throw err
  }
  post(id, { type: 'preview', rows, errors })
}

async function handleGenerateSample(id: number, bytes: number, seed: number): Promise<void> {
  const started = performance.now()
  const it = generateSampleChunks(bytes, seed)
  const hash = createIncrementalSha256()
  const encoder = new TextEncoder()
  const blobs: Blob[] = []
  let pending: string[] = []
  let produced = 0
  let lastPost = 0
  let step = await it.next()
  while (!step.done) {
    const chunk = step.value
    // Hash the exact bytes that go into the file.
    hash.update(encoder.encode(chunk))
    pending.push(chunk)
    produced += chunk.length
    // Move text into Blob storage every few chunks so strings can be collected.
    if (pending.length >= 8) {
      blobs.push(new Blob(pending, { type: 'text/csv' }))
      pending = []
    }
    const now = performance.now()
    if (now - lastPost >= 100) {
      lastPost = now
      post(id, { type: 'sampleProgress', bytes: produced })
    }
    step = await it.next()
  }
  if (pending.length > 0) blobs.push(new Blob(pending, { type: 'text/csv' }))
  const stats = step.value
  // The generator stops on a full row just under the target. Blank trailing lines (skipped by
  // the CSV reader) bring the file to exactly the requested size. They are hashed too.
  const short = bytes - blobs.reduce((n, b) => n + b.size, 0)
  if (short > 0 && short < 1024 * 1024) {
    const padding = '\n'.repeat(short)
    hash.update(encoder.encode(padding))
    blobs.push(new Blob([padding], { type: 'text/csv' }))
  }
  const file = new File(blobs, 'sample-litellm-spend-200mb.csv', { type: 'text/csv' })
  post(id, { type: 'sampleProgress', bytes: file.size })
  post(id, {
    type: 'sample',
    file,
    bytes: file.size,
    rows: stats.rows,
    columns: stats.columns,
    sourceMix: stats.sourceMix,
    ms: performance.now() - started,
    seed: stats.seed,
    sha256: hash.digestHex(),
    expectedNotPriced: stats.expectedNotPriced,
    expectedUnresolved: stats.expectedUnresolved,
  })
}

async function handle(env: RequestEnvelope): Promise<void> {
  const { id, request: req } = env
  switch (req.type) {
    case 'detect': {
      const file = req.file as File
      const text = await readSampleText(file)
      post(id, { type: 'detected', result: detectFromSample(text, file.name ?? '') })
      return
    }
    case 'import': {
      const p = handleImport(id, req)
      if (running?.id === id) importFinished = p
      return p
    }
    case 'cancel':
      return handleCancel(id)
    case 'rows':
      return handleRows(id, req.offset, req.limit)
    case 'row':
      return handleRow(id, req.rowIndex)
    case 'preview':
      return handlePreview(id, req)
    case 'exportCsv':
      return handleExportCsv(id, (req.target ?? null) as ExportTarget | null)
    case 'scenario':
      return handleScenario(id, req)
    case 'countRows':
      post(id, { type: 'count', rows: await countRows(req.auditId) })
      return
    case 'clear': {
      stopExports(EXPORT_STOPPED_BY_CLEAR)
      stopScenario(SCENARIO_STOPPED_BY_CLEAR)
      const run = running
      if (run) {
        run.sink.stop()
        run.controller.abort()
        await importFinished?.catch(() => undefined)
      }
      current = null
      await clearAll()
      post(id, { type: 'cleared' })
      return
    }
    case 'estimate': {
      const { usage, quota } = await storageEstimate()
      post(id, { type: 'estimate', usage, quota })
      return
    }
    case 'generateSample':
      return handleGenerateSample(id, req.bytes, req.seed)
  }
}

scope.addEventListener('message', (event: MessageEvent<RequestEnvelope>) => {
  const env = event.data
  if (!env || typeof env.id !== 'number' || !env.request) return
  handle(env).catch((err: unknown) => {
    post(env.id, isQuotaError(err) ? errorResponse('quota', new StoreQuotaError().message) : errorResponse(codeForError(err), messageOf(err)))
  })
})
