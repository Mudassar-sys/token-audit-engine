import { JSONParser, type ParsedElementInfo } from '@streamparser/json'
import type { RawRecord } from '../adapters/types'
import { ByteTextReader, emitBatches, type OnRecords, type StreamControl } from './reader'

export interface JsonPathOptions {
  /** @streamparser/json path selector, for example '$.*' or '$.data.*'. */
  path: string
  /** Extra selectors emitted alongside `path` (used with toRecords). */
  extraPaths?: string[]
  /**
   * Turn one emitted value into records. Default: one json record per value.
   * Must read `info.stack` synchronously: the parser reuses it.
   */
  toRecords?: (info: ParsedElementInfo) => RawRecord[]
  /** Records still held when the document ends (called once, after the last value). */
  onEnd?: () => RawRecord[]
  /** First non-space character the document must start with. */
  root: '[' | '{'
  /** What the document is, for error messages. */
  describe: string
}

/**
 * Streams the elements selected by one path out of a single JSON document.
 * keepStack is off, so emitted elements are released and memory stays flat.
 * A document that is cut short or broken yields one error record after the
 * elements that parsed before the fault.
 */
export async function streamJsonPath(
  file: Blob,
  opts: JsonPathOptions,
  control: StreamControl,
  onRecords: OnRecords,
): Promise<void> {
  const reader = new ByteTextReader(file, control)
  const parser = new JSONParser({ paths: [opts.path, ...(opts.extraPaths ?? [])], keepStack: false })
  let out: RawRecord[] = []
  const state: { failure: string | null } = { failure: null }
  let started = false
  const toRecords = opts.toRecords
  parser.onValue = (info) => {
    if (toRecords) {
      for (const r of toRecords(info)) out.push(r)
    } else {
      out.push({ kind: 'json', value: info.value, line: null })
    }
  }
  let ended = false
  const takeEnd = () => {
    if (ended) return
    ended = true
    if (opts.onEnd) for (const r of opts.onEnd()) out.push(r)
  }
  parser.onError = (err) => {
    state.failure ??= err.message
  }
  const flush = async () => {
    if (out.length === 0) return
    const batch = out
    out = []
    await emitBatches(batch, onRecords, control.signal)
  }
  const fail = async (message: string, raw: string) => {
    takeEnd()
    await flush()
    await emitBatches([{ kind: 'error', message, raw: raw.slice(0, 2000), line: null }], onRecords, control.signal)
  }
  try {
    for (;;) {
      const text = await reader.next()
      if (text === null) break
      if (text === '') continue
      let chunk = text
      if (!started) {
        chunk = chunk.replace(/^\uFEFF/, '')
        const first = /\S/.exec(chunk)
        if (!first) continue
        started = true
        if (first[0] !== opts.root) {
          await fail(`Expected ${opts.describe} starting with "${opts.root}"`, chunk.slice(first.index, first.index + 200))
          return
        }
      }
      if (parser.isEnded) {
        if (/\S/.test(chunk)) {
          await fail('Unexpected content after the end of the JSON document', chunk.trim().slice(0, 200))
          return
        }
        continue
      }
      parser.write(chunk)
      if (state.failure) {
        await fail(`Invalid JSON: ${state.failure}`, chunk.slice(0, 200))
        return
      }
      await flush()
    }
    if (!started) return
    if (!parser.isEnded) parser.end()
    if (!state.failure) takeEnd()
    await flush()
    if (state.failure) await fail(`The JSON document is incomplete: ${state.failure}`, '')
  } finally {
    reader.cancel()
  }
}
