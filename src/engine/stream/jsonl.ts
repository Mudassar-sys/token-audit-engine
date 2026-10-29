import type { RawRecord } from '../adapters/types'
import { ByteTextReader, emitBatches, type OnRecords, type StreamControl } from './reader'

const RAW_KEEP = 2000

/** Parse one line into a record. Returns null for a blank line. Line numbers are 1-based. */
export function parseJsonLine(text: string, line: number): RawRecord | null {
  let s = text.endsWith('\r') ? text.slice(0, -1) : text
  if (line === 1 && s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  if (s.trim() === '') return null
  try {
    return { kind: 'json', value: JSON.parse(s) as unknown, line }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { kind: 'error', message: `Line ${line} is not valid JSON: ${message}`, raw: s.slice(0, RAW_KEEP), line }
  }
}

/**
 * JSON Lines reader. Handles \n and \r\n, a final line without a newline, a BOM,
 * and blank lines. A line that does not parse becomes an error record.
 */
export async function streamJsonl(file: Blob, control: StreamControl, onRecords: OnRecords): Promise<void> {
  const reader = new ByteTextReader(file, control)
  let carry = ''
  let lineNo = 0
  try {
    for (;;) {
      const text = await reader.next()
      if (text === null) break
      if (text === '') continue
      carry += text
      if (!text.includes('\n')) continue
      const parts = carry.split('\n')
      carry = parts.pop() ?? ''
      const records: RawRecord[] = []
      for (const part of parts) {
        lineNo++
        const rec = parseJsonLine(part, lineNo)
        if (rec) records.push(rec)
      }
      if (records.length) await emitBatches(records, onRecords, control.signal)
    }
    if (carry !== '') {
      lineNo++
      const rec = parseJsonLine(carry, lineNo)
      if (rec) await emitBatches([rec], onRecords, control.signal)
    }
  } finally {
    reader.cancel()
  }
}
