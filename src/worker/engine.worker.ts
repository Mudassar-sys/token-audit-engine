import type { AuditRow, AuditSummary, NormalizedUsageRow, WorkerRequest, WorkerResponse } from '../engine/contracts'
import { runImport, type RowSink } from '../engine/pipeline'
import { detectFromSample, sampleRecordsFromText } from '../engine/detect'
import { adapterForVariant } from '../engine/adapters'
import { CSV_HEADER, auditRowToCsvLine } from '../engine/export'
import { generateSampleChunks } from '../engine/sample'
import {
  StoreQuotaError,
  clearAll,
  deleteAudit,
  getRow,
  getRows,
  isQuotaError,
  iterateRows,
  listAuditIds,
  putAudit,
  putRows,
} from './store'

/**
 * Engine worker. Every import, read and export runs here, off the main thread.
 * Messages travel in an envelope { id, request } / { id, response } so the client can match replies.
 */

export interface RequestEnvelope { id: number; request: WorkerRequest }
export interface ResponseEnvelope { id: number; response: WorkerResponse }

const scope = self as unknown as DedicatedWorkerGlobalScope

const SAMPLE_BYTES = 64 * 1024
const CSV_EXPORT_BATCH = 5000
const STORAGE_FACTOR = 3

interface RunningImport {
  id: number
  auditId: string
  controller: AbortController
  sink: TrackingSink
  cancel: { id: number; startedAt: number } | null
}

let running: RunningImport | null = null
let importFinished: Promise<void> | null = null
let currentAuditId: string | null = null

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

async function handleImport(id: number, req: Extract<WorkerRequest, { type: 'import' }>): Promise<void> {
  if (running) {
    post(id, errorResponse('internal', 'An import is already running. Cancel it first.'))
    return
  }
  const file = req.file as Blob
  const auditId = newAuditId()
  const controller = new AbortController()
  const sink = new TrackingSink(auditId)
  const run: RunningImport = { id, auditId, controller, sink, cancel: null }
  running = run

  try {
    const { usage, quota } = await storageEstimate()
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
    currentAuditId = null
    await putAudit({ auditId, status: 'importing', fileName: req.fileName, startedAt: new Date().toISOString(), summary: null })

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
    if (controller.signal.aborted) throw new DOMException('Import cancelled', 'AbortError')
    await sink.drain()
    if (sink.firstError) throw sink.firstError
    const summary: AuditSummary = { ...result, auditId }
    await putAudit({ auditId, status: 'done', fileName: req.fileName, startedAt: new Date().toISOString(), summary })
    currentAuditId = auditId
    post(id, { type: 'done', summary })
  } catch (err) {
    sink.stop()
    controller.abort()
    await sink.drain()
    const quotaHit = isQuotaError(err) || isQuotaError(sink.firstError)
    if (run.cancel && !quotaHit) {
      const cancelMs = performance.now() - run.cancel.startedAt
      const deleteStart = performance.now()
      const deleted = await deleteQuietly(auditId)
      const deleteMs = performance.now() - deleteStart
      const res: WorkerResponse = { type: 'cancelled', cancelMs, deleteMs, partialRowsDeleted: deleted }
      post(id, res)
      post(run.cancel.id, res)
    } else if (quotaHit) {
      await deleteQuietly(auditId)
      post(id, errorResponse('quota', new StoreQuotaError().message + ' Partial rows were deleted.'))
      if (run.cancel) post(run.cancel.id, { type: 'cancelled', cancelMs: performance.now() - run.cancel.startedAt, deleteMs: 0, partialRowsDeleted: true })
    } else if (isAbortError(err)) {
      await deleteQuietly(auditId)
      post(id, { type: 'cancelled', cancelMs: 0, deleteMs: 0, partialRowsDeleted: true })
    } else {
      await deleteQuietly(auditId)
      post(id, errorResponse(codeForError(err), messageOf(err)))
    }
  } finally {
    if (running === run) running = null
  }
}

function handleCancel(id: number): void {
  const run = running
  if (!run) {
    post(id, { type: 'cancelled', cancelMs: 0, deleteMs: 0, partialRowsDeleted: false })
    return
  }
  if (run.cancel) return
  run.cancel = { id, startedAt: performance.now() }
  run.sink.stop()
  run.controller.abort()
}

async function handleRows(id: number, offset: number, limit: number): Promise<void> {
  const rows = currentAuditId ? await getRows(currentAuditId, offset, Math.min(Math.max(0, limit), 1000)) : []
  post(id, { type: 'rows', offset, rows })
}

async function handleRow(id: number, rowIndex: number): Promise<void> {
  post(id, { type: 'row', row: currentAuditId ? await getRow(currentAuditId, rowIndex) : null })
}

async function handleExportCsv(id: number): Promise<void> {
  if (!currentAuditId) {
    post(id, errorResponse('internal', 'There is no audit to export yet.'))
    return
  }
  const parts: BlobPart[] = [CSV_HEADER]
  const total = await iterateRows(currentAuditId, CSV_EXPORT_BATCH, (rows) => {
    // One part per batch of 5,000 rows: never one giant string.
    parts.push(rows.map(auditRowToCsvLine).join(''))
  })
  const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' })
  post(id, { type: 'csv', blob, rows: total })
}

async function handlePreview(id: number, req: Extract<WorkerRequest, { type: 'preview' }>): Promise<void> {
  const text = await readSampleText(req.file as Blob)
  const records = sampleRecordsFromText(text, 'H-csv', 21)
  const run = adapterForVariant('H-csv').begin({ variant: 'H-csv', mapping: req.mapping, fileFacts: {} })
  const rows: NormalizedUsageRow[] = []
  const errors: string[] = []
  for (const record of records) {
    if (rows.length >= 20) break
    if (record.kind === 'error') errors.push(`Line ${record.line ?? '?'}: ${record.message}`)
    for (const row of run.push(record)) {
      if (rows.length >= 20) break
      const full: NormalizedUsageRow = { ...row, rowIndex: rows.length }
      rows.push(full)
      if (full.unresolvedReason) errors.push(`Row ${full.rowIndex + 1}: ${full.unresolvedReason}`)
    }
  }
  post(id, { type: 'preview', rows, errors })
}

async function handleGenerateSample(id: number, bytes: number, seed: number): Promise<void> {
  const started = performance.now()
  const it = generateSampleChunks(bytes, seed)
  const blobs: Blob[] = []
  let pending: string[] = []
  let produced = 0
  let lastPost = 0
  let step = await it.next()
  while (!step.done) {
    const chunk = step.value
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
  // the CSV reader) bring the file to exactly the requested size.
  const short = bytes - blobs.reduce((n, b) => n + b.size, 0)
  if (short > 0 && short < 1024 * 1024) blobs.push(new Blob(['\n'.repeat(short)], { type: 'text/csv' }))
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
      return handleExportCsv(id)
    case 'clear': {
      const run = running
      if (run) {
        run.sink.stop()
        run.controller.abort()
        await importFinished?.catch(() => undefined)
      }
      currentAuditId = null
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
