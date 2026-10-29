import Papa from 'papaparse'
import type { RawRecord } from '../adapters/types'
import {
  abortError,
  abortPromise,
  ByteTextReader,
  emitBatches,
  type OnRecords,
  type StreamControl,
} from './reader'

export const DEFAULT_CSV_CHUNK = 4 * 1024 * 1024
const DELIMITERS = [',', '\t', ';', '|'] as const
const EXTRA_KEY = '__parsed_extra'

type Listener = (arg?: unknown) => void

/**
 * Minimal Node-style readable that Papa Parse accepts as a stream input.
 * Text is pushed in by the byte reader loop; pause() and resume() gate that loop.
 */
export class TextStreamShim {
  readonly readable = true
  private readonly listeners = new Map<string, Set<Listener>>()
  private paused = false
  private waiters: (() => void)[] = []

  read(): void {}

  on(event: string, fn: Listener): this {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn)
    return this
  }

  removeListener(event: string, fn: Listener): this {
    this.listeners.get(event)?.delete(fn)
    return this
  }

  emit(event: 'data' | 'end' | 'error', arg?: unknown): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(arg)
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    const w = this.waiters
    this.waiters = []
    for (const fn of w) fn()
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Resolves once the consumer has resumed the stream. */
  whenResumed(): Promise<void> {
    if (!this.paused) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }
}

/** Pick the delimiter that occurs most often outside quotes in the header line. */
export function guessDelimiter(headerLine: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]))
  let inQuotes = false
  for (const ch of headerLine) {
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  let best = ','
  let bestCount = 0
  for (const [d, n] of counts) {
    if (n > bestCount) {
      best = d
      bestCount = n
    }
  }
  return best
}

function countLineBreaks(value: string): number {
  let n = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c === 10) n++
    else if (c === 13 && value.charCodeAt(i + 1) !== 10) n++
  }
  return n
}

interface ChunkResults {
  data: Record<string, unknown>[]
  errors: { code?: string; message: string; row?: number }[]
}

interface ParserHandle {
  pause(): void
  resume(): void
  abort(): void
}

/**
 * CSV reader. Bytes are decoded by one streaming decoder (so multibyte characters
 * split across chunks stay whole) and the text is fed to Papa Parse through a
 * Node-style readable shim, header mode, no worker. In each chunk callback the
 * parser is paused while onRecords runs, then resumed.
 * Rows that Papa reports an error for (wrong field count, broken quotes) become
 * error records with their line number. Blank rows are skipped like Papa's
 * 'greedy' option, but here, so the line count stays exact.
 */
export async function streamCsv(file: Blob, control: StreamControl, onRecords: OnRecords): Promise<void> {
  const chunkSize = Math.max(1, control.csvChunkSize ?? DEFAULT_CSV_CHUNK)
  const reader = new ByteTextReader(file, control, chunkSize)
  const shim = new TextStreamShim()
  const signal = control.signal
  const ab = abortPromise(signal)

  let pending: Promise<void> | null = null
  let failure: unknown = null
  let resolveDone!: () => void
  let rejectDone!: (err: unknown) => void
  const done = new Promise<void>((res, rej) => {
    resolveDone = res
    rejectDone = rej
  })
  done.catch(() => {})
  const fail = (err: unknown) => {
    failure ??= err
    rejectDone(err)
  }

  let headerFields: string[] | null = null
  let rowsBefore = 0
  let nextLine = 2
  let firstChunk = true

  const toRecords = (results: ChunkResults, fields: string[]): RawRecord[] => {
    const rowErrors = new Map<number, string[]>()
    const loose: string[] = []
    for (const e of results.errors) {
      const msg = e.code ? `${e.code}: ${e.message}` : e.message
      let idx: number | undefined
      if (typeof e.row === 'number') {
        // Field-count errors carry a running row index; quote errors carry a chunk-relative one.
        idx = e.code === 'TooFewFields' || e.code === 'TooManyFields' ? e.row - rowsBefore : e.row - (firstChunk ? 1 : 0)
      }
      if (idx !== undefined && idx >= 0 && idx < results.data.length) {
        const list = rowErrors.get(idx) ?? []
        list.push(msg)
        rowErrors.set(idx, list)
      } else {
        loose.push(msg)
      }
    }
    const out: RawRecord[] = []
    results.data.forEach((row, i) => {
      const line = nextLine
      const values: string[] = []
      const clean: Record<string, string> = {}
      for (const f of fields) {
        const v = row[f]
        if (typeof v === 'string') {
          clean[f] = v
          values.push(v)
        }
      }
      const extra = row[EXTRA_KEY]
      if (Array.isArray(extra)) for (const v of extra) values.push(String(v))
      for (const v of values) if (v.includes('\n') || v.includes('\r')) nextLine += countLineBreaks(v)
      nextLine += 1
      // Blank rows are skipped here (the 'greedy' rule) rather than by Papa, so line numbers stay exact.
      if (values.every((v) => v.trim() === '')) return
      const errs = rowErrors.get(i)
      if (errs) {
        out.push({ kind: 'error', message: `Line ${line}: ${errs.join('; ')}`, raw: values.join(',').slice(0, 2000), line })
      } else {
        out.push({ kind: 'csv', row: clean, line })
      }
    })
    for (const msg of loose) out.push({ kind: 'error', message: msg, raw: '', line: null })
    rowsBefore += results.data.length
    firstChunk = false
    return out
  }

  const start = (delimiter: string, newline: string) => {
    const parse = Papa.parse as unknown as (input: unknown, config: Record<string, unknown>) => void
    parse(shim, {
      header: true,
      worker: false,
      skipEmptyLines: false,
      delimiter,
      newline,
      chunk: (results: ChunkResults & { meta: { fields?: string[] } }, handle: ParserHandle) => {
        if (failure) return
        if (headerFields === null) headerFields = results.meta.fields ?? []
        const records = toRecords(results, headerFields)
        if (records.length === 0) return
        handle.pause()
        shim.pause()
        pending = emitBatches(records, onRecords, signal).then(
          () => {
            pending = null
            if (signal.aborted) {
              fail(abortError())
              return
            }
            shim.resume()
            try {
              handle.resume()
            } catch (err) {
              fail(err)
            }
          },
          (err: unknown) => {
            pending = null
            fail(err)
            shim.resume()
            handle.abort()
          },
        )
      },
      complete: () => resolveDone(),
      error: (err: unknown) => fail(err),
    })
  }

  const waitIdle = async () => {
    while (pending || shim.isPaused) {
      await Promise.race([pending ?? shim.whenResumed(), ab.promise])
      if (failure) throw failure
    }
  }

  let buffer = ''
  let started = false
  const push = (text: string) => {
    if (text) shim.emit('data', text)
  }

  try {
    for (;;) {
      if (failure) throw failure
      await waitIdle()
      const text = await reader.next()
      if (text === null) break
      buffer += text
      if (!started) {
        const nl = buffer.indexOf('\n')
        if (nl < 0) continue
        const header = buffer.slice(0, nl)
        start(guessDelimiter(header.replace(/\r$/, '')), header.endsWith('\r') ? '\r\n' : '\n')
        started = true
      }
      if (buffer.length >= chunkSize) {
        const t = buffer
        buffer = ''
        push(t)
      }
    }
    if (!started) {
      if (buffer.trim() === '') return
      start(guessDelimiter(buffer), buffer.includes('\r') ? '\r' : '\n')
      started = true
    }
    await waitIdle()
    const rest = buffer
    buffer = ''
    push(rest)
    await waitIdle()
    shim.emit('end')
    await Promise.race([done, ab.promise])
    if (failure) throw failure
  } finally {
    ab.dispose()
    reader.cancel()
  }
}
