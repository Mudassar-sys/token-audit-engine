/**
 * Sinks for the row CSV export. The worker writes the header and every row through one of them:
 * a file handle's writable stream, or a Blob built from parts of about 8 MiB.
 */

/** The Blob fallback moves its text buffer into a Blob part each time it reaches this many UTF-8 bytes. */
export const EXPORT_PART_BYTES = 8 * 1024 * 1024

/** The writable stream part of a FileSystemFileHandle that the export uses. */
export interface ExportWritable {
  write(data: string): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

/** A file handle the main thread chose (save dialog or origin private file system). */
export interface ExportTarget {
  createWritable(): Promise<ExportWritable>
}

/** UTF-8 byte length of a string, without encoding it. A lone surrogate counts as U+FFFD (3 bytes). */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}

/** Where the export writes: a file handle stream, or Blob parts. */
export interface ExportSink {
  write(text: string): Promise<void>
  finish(): Promise<Blob | null>
  abort(): Promise<void>
}

export async function streamSink(target: ExportTarget): Promise<ExportSink> {
  const w = await target.createWritable()
  return {
    write: (text) => w.write(text),
    async finish() {
      await w.close()
      return null
    },
    async abort() {
      try {
        await w.abort()
      } catch {
        // The stream is already closed or errored; nothing was committed.
      }
    },
  }
}

/** Blob fallback: one text buffer, moved into a Blob part each time it reaches EXPORT_PART_BYTES. */
export function blobSink(): ExportSink {
  const parts: Blob[] = []
  let buf = ''
  let bufBytes = 0
  return {
    async write(text) {
      buf += text
      bufBytes += utf8Length(text)
      if (bufBytes >= EXPORT_PART_BYTES) {
        parts.push(new Blob([buf]))
        buf = ''
        bufBytes = 0
      }
    },
    async finish() {
      if (buf) parts.push(new Blob([buf]))
      buf = ''
      return new Blob(parts, { type: 'text/csv;charset=utf-8' })
    },
    async abort() {
      parts.length = 0
      buf = ''
    },
  }
}
