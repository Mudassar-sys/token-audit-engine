import type { RawRecord } from '../adapters/types'

/** Options every stream reader receives. See streamRecords in ./index. */
export interface StreamControl {
  signal: AbortSignal
  /** Cumulative bytes read so far. */
  onBytes(bytesRead: number): void
  /** Every raw byte chunk in order, for the incremental file hash. */
  onChunk(bytes: Uint8Array): void
  /** Test hook: byte slice size and minimum text chunk handed to the CSV parser. Default 4 MiB. */
  csvChunkSize?: number
}

export type OnRecords = (records: RawRecord[]) => void | Promise<void>

/** Records per onRecords call. */
export const RECORD_BATCH = 1000

/** The error every reader throws when the signal aborts. */
export function abortError(): DOMException {
  return new DOMException('The import was cancelled', 'AbortError')
}

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

/** A promise that rejects with an AbortError when the signal aborts. Never settles otherwise. */
export function abortPromise(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let onAbort: (() => void) | null = null
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
  })
  promise.catch(() => {})
  return {
    promise,
    dispose() {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    },
  }
}

/** Await a value but give up as soon as the signal aborts. */
export async function raceAbort<T>(value: Promise<T> | T, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (!(value instanceof Promise)) return value
  const ab = abortPromise(signal)
  try {
    return await Promise.race([value, ab.promise])
  } finally {
    ab.dispose()
  }
}

/** Hand records to onRecords in batches of RECORD_BATCH, awaiting each call (backpressure). */
export async function emitBatches(records: RawRecord[], onRecords: OnRecords, signal: AbortSignal): Promise<void> {
  for (let i = 0; i < records.length; i += RECORD_BATCH) {
    throwIfAborted(signal)
    const batch = records.length <= RECORD_BATCH ? records : records.slice(i, i + RECORD_BATCH)
    await raceAbort(onRecords(batch), signal)
  }
  throwIfAborted(signal)
}

/**
 * Reads a Blob once as UTF-8 text. Every byte chunk goes to onChunk before decoding.
 * Decoding keeps state across chunks, so a multibyte character split over a boundary
 * comes out whole, and a leading BOM is dropped.
 */
export class ByteTextReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder('utf-8')
  private leftover: Uint8Array | null = null
  private bytesRead = 0
  private done = false
  private readonly onAbort: () => void

  constructor(
    file: Blob,
    private readonly control: StreamControl,
    private readonly sliceSize = Number.POSITIVE_INFINITY,
  ) {
    this.reader = (file.stream() as ReadableStream<Uint8Array>).getReader()
    this.onAbort = () => {
      this.reader.cancel().catch(() => {})
    }
    control.signal.addEventListener('abort', this.onAbort, { once: true })
  }

  /** Next decoded text piece ('' is possible), or null at the end of the file. */
  async next(): Promise<string | null> {
    throwIfAborted(this.control.signal)
    if (this.done) return null
    let bytes: Uint8Array
    if (this.leftover) {
      bytes = this.leftover
      this.leftover = null
    } else {
      const { value, done } = await this.reader.read()
      throwIfAborted(this.control.signal)
      if (done || !value) {
        this.done = true
        this.release()
        return this.decoder.decode()
      }
      bytes = value
    }
    if (bytes.byteLength > this.sliceSize) {
      this.leftover = bytes.subarray(this.sliceSize)
      bytes = bytes.subarray(0, this.sliceSize)
    }
    this.bytesRead += bytes.byteLength
    this.control.onChunk(bytes)
    this.control.onBytes(this.bytesRead)
    return this.decoder.decode(bytes, { stream: true })
  }

  /** Stop reading and free the underlying stream. */
  cancel(): void {
    if (!this.done) {
      this.done = true
      this.reader.cancel().catch(() => {})
    }
    this.release()
  }

  private release(): void {
    this.control.signal.removeEventListener('abort', this.onAbort)
  }
}
