import type { VariantId } from '../contracts'
import type { RawRecord } from '../adapters/types'
import { streamCsv } from './csv'
import { streamJsonPath } from './jsonArray'
import { streamJsonl } from './jsonl'
import { OTLP_EXTRA_PATHS, OTLP_SPAN_PATH, OtlpSpanAssembler } from './otlp'
import { isAbortError, type OnRecords, type StreamControl } from './reader'

export type { StreamControl, OnRecords } from './reader'
export { abortError, isAbortError, RECORD_BATCH } from './reader'

export type StreamFormat = 'json-array' | 'jsonl' | 'usage-page' | 'otlp' | 'otlp-jsonl' | 'csv'

/** Container format each variant is read with. */
export const VARIANT_FORMAT: Readonly<Record<VariantId, StreamFormat>> = {
  'A-json': 'json-array',
  'A-jsonl': 'jsonl',
  'B-json': 'json-array',
  'B-jsonl': 'jsonl',
  'C-page': 'usage-page',
  'D-json': 'json-array',
  'D-jsonl': 'jsonl',
  'E-json': 'json-array',
  'E-jsonl': 'jsonl',
  'F-csv': 'csv',
  'F-json': 'json-array',
  'G-otlp': 'otlp',
  'G-otlp-jsonl': 'otlp-jsonl',
  'H-csv': 'csv',
}

export function streamFormatForVariant(v: VariantId): StreamFormat {
  return VARIANT_FORMAT[v]
}

/**
 * Read a file once and hand its records to onRecords in batches of up to 1,000.
 * - jsonl / otlp-jsonl: one JSON value per line (an OTLP export request per line for otlp-jsonl).
 * - json-array: each element of the top-level array.
 * - usage-page: each bucket of `data` in a usage page.
 * - otlp: each span of one export request, streamed one span at a time, as a one-span export
 *   request `{ resourceSpans: [{ resource, scopeSpans: [{ scope, spans: [span] }] }] }`.
 * - csv: one record per data row, keyed by header.
 * If onRecords returns a promise, reading waits for it. On abort, throws an AbortError.
 */
export async function streamRecords(
  file: Blob,
  format: StreamFormat,
  control: StreamControl,
  onRecords: OnRecords,
): Promise<void> {
  switch (format) {
    case 'jsonl':
    case 'otlp-jsonl':
      return streamJsonl(file, control, onRecords)
    case 'json-array':
      return streamJsonPath(file, { path: '$.*', root: '[', describe: 'a JSON array' }, control, onRecords)
    case 'usage-page':
      return streamJsonPath(file, { path: '$.data.*', root: '{', describe: 'a usage page object' }, control, onRecords)
    case 'otlp': {
      const spans = new OtlpSpanAssembler()
      return streamJsonPath(
        file,
        {
          path: OTLP_SPAN_PATH,
          extraPaths: [...OTLP_EXTRA_PATHS],
          root: '{',
          describe: 'an OTLP export request object',
          toRecords: (info) => spans.value(info),
          onEnd: () => spans.end(),
        },
        control,
        onRecords,
      )
    }
    case 'csv':
      return streamCsv(file, control, onRecords)
  }
}

/**
 * Read up to `max` records from the start of a file, then stop reading.
 * Used for file-level fact scans before the main pass.
 */
export async function sampleRecordsFromBlob(
  file: Blob,
  format: StreamFormat,
  max: number,
  signal?: AbortSignal,
): Promise<RawRecord[]> {
  const out: RawRecord[] = []
  if (max <= 0) return out
  const ac = new AbortController()
  const forward = () => ac.abort()
  if (signal?.aborted) ac.abort()
  signal?.addEventListener('abort', forward, { once: true })
  try {
    await streamRecords(file, format, { signal: ac.signal, onBytes() {}, onChunk() {} }, (records) => {
      for (const r of records) {
        if (out.length >= max) break
        out.push(r)
      }
      if (out.length >= max) ac.abort()
    })
  } catch (err) {
    if (!isAbortError(err) || signal?.aborted) throw err
  } finally {
    signal?.removeEventListener('abort', forward)
  }
  return out
}
