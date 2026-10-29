import type {
  AuditRow,
  AuditSummary,
  CustomCsvMapping,
  DetectionResult,
  FrozenSnapshot,
  NormalizedUsageRow,
  PricingSnapshot,
  Progress,
  ScenarioRequest,
  ScenarioResult,
  VariantId,
  WorkerRequest,
  WorkerResponse,
} from '../engine/contracts'
import type { RequestEnvelope, ResponseEnvelope } from '../worker/engine.worker'

/** Error reported by the engine worker. */
export class EngineError extends Error {
  constructor(readonly code: 'quota' | 'parse' | 'unsupported' | 'internal', message: string) {
    super(message)
    this.name = 'EngineError'
  }
}

export interface CancelOutcome {
  cancelMs: number
  deleteMs: number
  partialRowsDeleted: boolean
  /** The cancelled import's audit id, or null when no import was running. */
  auditId: string | null
}

export type ImportOutcome = { kind: 'done'; summary: AuditSummary } | ({ kind: 'cancelled' } & CancelOutcome)

export interface ExportResult {
  /** 'stream': written to the chosen file handle. 'blob': returned as a Blob to download. */
  path: 'stream' | 'blob'
  /** null on the stream path. */
  blob: Blob | null
  rows: number
  /** UTF-8 bytes written, header included. */
  bytes: number
  ms: number
}

export interface ImportRequest {
  file: Blob
  fileName: string
  variant: VariantId
  detection: DetectionResult
  overridden: boolean
  mapping: CustomCsvMapping | null
  snapshot: PricingSnapshot
  snapshotMeta: FrozenSnapshot & { sourceUrl: string }
}

export interface SampleResult {
  file: File
  bytes: number
  rows: number
  columns: number
  sourceMix: Record<string, number>
  ms: number
  seed: number
  /** SHA-256 of the exact file bytes, padding included. */
  sha256: string
  expectedNotPriced: number
  expectedUnresolved: number
}

interface Pending {
  /** Return true when the response settles this request. */
  onResponse(res: WorkerResponse): boolean
  reject(err: unknown): void
}

type Of<T extends WorkerResponse['type']> = Extract<WorkerResponse, { type: T }>

/** Promise-based wrapper around the engine worker. One promise per request. */
export class EngineClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private importInFlight = false

  constructor(worker?: Worker) {
    this.worker = worker ?? new Worker(new URL('../worker/engine.worker.ts', import.meta.url), { type: 'module' })
    this.worker.addEventListener('message', (e: MessageEvent<ResponseEnvelope>) => this.receive(e.data))
    this.worker.addEventListener('error', (e: ErrorEvent) => this.failAll(new EngineError('internal', e.message || 'The engine worker stopped.')))
  }

  get busy(): boolean {
    return this.importInFlight
  }

  private receive(env: ResponseEnvelope): void {
    if (!env || typeof env.id !== 'number') return
    const p = this.pending.get(env.id)
    if (!p) return
    if (p.onResponse(env.response)) this.pending.delete(env.id)
  }

  private failAll(err: unknown): void {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    this.importInFlight = false
  }

  private send(request: WorkerRequest, pending: Pending): void {
    const id = this.nextId++
    this.pending.set(id, pending)
    const env: RequestEnvelope = { id, request }
    this.worker.postMessage(env)
  }

  /** Send a request that settles on one response type, or rejects on an error response. */
  private call<T extends WorkerResponse['type']>(request: WorkerRequest, type: T, onOther?: (res: WorkerResponse) => void): Promise<Of<T>> {
    return new Promise<Of<T>>((resolve, reject) => {
      this.send(request, {
        onResponse: (res) => {
          if (res.type === type) {
            resolve(res as Of<T>)
            return true
          }
          if (res.type === 'error') {
            reject(new EngineError(res.code, res.message))
            return true
          }
          onOther?.(res)
          return false
        },
        reject,
      })
    })
  }

  async detect(file: File): Promise<DetectionResult> {
    return (await this.call({ type: 'detect', file }, 'detected')).result
  }

  /** Run an import. Resolves with the summary, or with the cancel outcome; rejects with EngineError. */
  importFile(req: ImportRequest, onProgress?: (p: Progress) => void): Promise<ImportOutcome> {
    this.importInFlight = true
    const message: WorkerRequest = { type: 'import', ...req }
    return new Promise<ImportOutcome>((resolve, reject) => {
      this.send(message, {
        onResponse: (res) => {
          switch (res.type) {
            case 'progress':
              onProgress?.(res.progress)
              return false
            case 'done':
              this.importInFlight = false
              resolve({ kind: 'done', summary: res.summary })
              return true
            case 'cancelled':
              this.importInFlight = false
              resolve({ kind: 'cancelled', cancelMs: res.cancelMs, deleteMs: res.deleteMs, partialRowsDeleted: res.partialRowsDeleted, auditId: res.auditId })
              return true
            case 'error':
              this.importInFlight = false
              reject(new EngineError(res.code, res.message))
              return true
            default:
              return false
          }
        },
        reject: (err) => {
          this.importInFlight = false
          reject(err)
        },
      })
    })
  }

  /** Ask the running import to stop. Resolves when the worker confirms, after partial rows are deleted. */
  async cancel(): Promise<CancelOutcome> {
    const res = await this.call({ type: 'cancel' }, 'cancelled')
    return { cancelMs: res.cancelMs, deleteMs: res.deleteMs, partialRowsDeleted: res.partialRowsDeleted, auditId: res.auditId }
  }

  /** Number of rows stored for an audit. 0 after a cancelled import deleted its partial rows. */
  async countRows(auditId: string): Promise<number> {
    return (await this.call({ type: 'countRows', auditId }, 'count')).rows
  }

  /** Reprice the open audit's rows under a scenario, in the worker. */
  async scenario(request: ScenarioRequest, onProgress?: (p: { rowsDone: number; rowsTotal: number }) => void): Promise<ScenarioResult> {
    const res = await this.call({ type: 'scenario', request }, 'scenario', (other) => {
      if (other.type === 'scenarioProgress') onProgress?.({ rowsDone: other.rowsDone, rowsTotal: other.rowsTotal })
    })
    return res.result
  }

  async rows(offset: number, limit: number): Promise<AuditRow[]> {
    return (await this.call({ type: 'rows', offset, limit }, 'rows')).rows
  }

  async row(rowIndex: number): Promise<AuditRow | null> {
    return (await this.call({ type: 'row', rowIndex }, 'row')).row
  }

  async preview(file: File, mapping: CustomCsvMapping): Promise<{ rows: NormalizedUsageRow[]; errors: string[] }> {
    const res = await this.call({ type: 'preview', file, mapping }, 'preview')
    return { rows: res.rows, errors: res.errors }
  }

  /**
   * Export the open audit's rows as CSV. With a file handle the worker streams into it;
   * with null it returns a Blob built from parts of about 8 MiB.
   */
  async exportCsv(target: FileSystemFileHandle | null, onProgress?: (p: { rows: number; bytes: number }) => void): Promise<ExportResult> {
    const res = await this.call({ type: 'exportCsv', target }, 'csv', (other) => {
      if (other.type === 'exportProgress') onProgress?.({ rows: other.rows, bytes: other.bytes })
    })
    return { path: res.path, blob: (res.blob as Blob | null) ?? null, rows: res.rows, bytes: res.bytes, ms: res.ms }
  }

  async clear(): Promise<void> {
    await this.call({ type: 'clear' }, 'cleared')
  }

  async estimate(): Promise<{ usage: number | null; quota: number | null }> {
    const res = await this.call({ type: 'estimate' }, 'estimate')
    return { usage: res.usage, quota: res.quota }
  }

  async generateSample(bytes: number, seed: number, onProgress?: (bytes: number) => void): Promise<SampleResult> {
    const res = await this.call({ type: 'generateSample', bytes, seed }, 'sample', (other) => {
      if (other.type === 'sampleProgress') onProgress?.(other.bytes)
    })
    return {
      file: res.file as File,
      bytes: res.bytes,
      rows: res.rows,
      columns: res.columns,
      sourceMix: res.sourceMix,
      ms: res.ms,
      seed: res.seed,
      sha256: res.sha256,
      expectedNotPriced: res.expectedNotPriced,
      expectedUnresolved: res.expectedUnresolved,
    }
  }

  terminate(): void {
    this.worker.terminate()
    this.failAll(new EngineError('internal', 'The engine worker was stopped.'))
  }
}

let shared: EngineClient | null = null

/** The app-wide client, created on first use. */
export function getEngineClient(): EngineClient {
  if (!shared) shared = new EngineClient()
  return shared
}
