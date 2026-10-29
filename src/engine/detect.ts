import Papa from 'papaparse'
import type { DetectionResult, VariantId } from './contracts'
import { ADAPTERS, VARIANTS } from './adapters'
import type { Adapter, RawRecord } from './adapters/types'
import type { StreamFormat } from './stream'
import { guessDelimiter } from './stream/csv'
import { parseJsonLine } from './stream/jsonl'

/**
 * Format detection from the first 64 KiB of a file. The container (JSON array, JSON Lines,
 * one JSON object, CSV) picks the candidate variants; each adapter then scores sample records.
 */

export const SAMPLE_BYTES = 64 * 1024
/** Below this score nothing is plausible and the file is "not supported yet". */
const MIN_SCORE = 0.3
/** Records scored per candidate. */
const SCORE_RECORDS = 20
const RAW_KEEP = 2000
const NOT_SUPPORTED = 'not supported yet'

/** Container format each variant is read with. */
export function formatForVariant(v: VariantId): StreamFormat {
  const info = VARIANTS.find((x) => x.id === v)
  if (!info) throw new Error(`Unknown variant ${v}`)
  return info.format
}

// ---------------------------------------------------------------------------
// Prefix JSON parsing: parse as much of a possibly cut-off document as is complete.

/** Containers that were still open when the text ended. */
const INCOMPLETE = new WeakSet<object>()
const MAX_DEPTH = 512

interface Prefix {
  value: unknown
  /** True when the text ended before the first value closed. */
  cut: boolean
  /** Index just after the first value (or text length when cut). */
  end: number
}

/** Thrown when the text is not JSON at all (as opposed to being cut short). */
class NotJson extends Error {}

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const SKIP = Symbol('skip')

/**
 * Parse the first JSON value in `text`. When the text ends early, open containers are
 * closed and marked incomplete, and a cut string, number or literal is dropped.
 */
export function parseJsonPrefix(text: string, from = 0): Prefix {
  let i = from
  let cut = false

  const ws = () => {
    while (i < text.length) {
      const c = text.charCodeAt(i)
      if (c === 32 || c === 9 || c === 10 || c === 13) i++
      else break
    }
  }

  const str = (): string | typeof SKIP => {
    const start = i
    i++
    while (i < text.length) {
      const c = text[i]
      if (c === '\\') i += 2
      else if (c === '"') {
        i++
        try {
          return JSON.parse(text.slice(start, i)) as string
        } catch {
          throw new NotJson('bad string')
        }
      } else i++
    }
    cut = true
    return SKIP
  }

  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new NotJson('nested too deeply')
    ws()
    if (i >= text.length) {
      cut = true
      return SKIP
    }
    const c = text[i]
    if (c === '{') return object(depth)
    if (c === '[') return array(depth)
    if (c === '"') return str()
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, i)) {
        i += word.length
        return v
      }
      if (word.startsWith(text.slice(i))) {
        cut = true
        i = text.length
        return SKIP
      }
    }
    NUMBER_RE.lastIndex = i
    const m = NUMBER_RE.exec(text)
    if (!m) throw new NotJson(`unexpected "${c}"`)
    i += m[0].length
    if (i >= text.length) {
      cut = true
      return SKIP
    }
    return Number(m[0])
  }

  const object = (depth: number): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    i++
    ws()
    if (text[i] === '}') {
      i++
      return out
    }
    for (;;) {
      ws()
      if (i >= text.length) break
      if (text[i] !== '"') throw new NotJson('expected a key')
      const key = str()
      if (key === SKIP) break
      ws()
      if (i >= text.length) {
        cut = true
        break
      }
      if (text[i] !== ':') throw new NotJson('expected ":"')
      i++
      const v = value(depth + 1)
      if (v !== SKIP) out[key] = v
      if (cut) break
      ws()
      if (i >= text.length) break
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === '}') {
        i++
        return out
      }
      throw new NotJson('expected "," or "}"')
    }
    cut = true
    INCOMPLETE.add(out)
    return out
  }

  const array = (depth: number): unknown[] => {
    const out: unknown[] = []
    i++
    ws()
    if (text[i] === ']') {
      i++
      return out
    }
    for (;;) {
      const v = value(depth + 1)
      if (v !== SKIP) out.push(v)
      if (cut) break
      ws()
      if (i >= text.length) break
      if (text[i] === ',') {
        i++
        continue
      }
      if (text[i] === ']') {
        i++
        return out
      }
      throw new NotJson('expected "," or "]"')
    }
    cut = true
    INCOMPLETE.add(out)
    return out
  }

  const v = value(0)
  return { value: v === SKIP ? undefined : v, cut, end: i }
}

function isComplete(v: unknown): boolean {
  return !(v !== null && typeof v === 'object' && INCOMPLETE.has(v))
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Sample records

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** UTF-8 byte length without allocating. */
function utf8Length(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** A sample cut from a longer file (the reader stops at 64 KiB) may end mid-record. */
function looksTruncated(text: string): boolean {
  return text.length > SAMPLE_BYTES || utf8Length(text) >= SAMPLE_BYTES - 3
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

function jsonlRecords(text: string, max: number, truncated: boolean): RawRecord[] {
  const out: RawRecord[] = []
  const lines = text.split('\n')
  const endsClean = text.endsWith('\n')
  for (let n = 0; n < lines.length && out.length < max; n++) {
    const rec = parseJsonLine(lines[n] ?? '', n + 1)
    if (!rec) continue
    const last = n === lines.length - 1 && !endsClean
    if (last && truncated && rec.kind === 'error') break
    out.push(rec)
  }
  return out
}

/** Elements of a JSON array that closed before the sample ended (or the first one, when none did). */
function completeElements(list: unknown, max: number): unknown[] {
  if (!Array.isArray(list)) return []
  const done = list.filter(isComplete)
  return (done.length > 0 ? done : list.slice(0, 1)).slice(0, max)
}

/** A resourceSpans element cut short keeps only spans that closed. */
function trimResourceSpans(rs: unknown): unknown {
  if (isComplete(rs) || !isObj(rs)) return rs
  const scopes = Array.isArray(rs.scopeSpans) ? rs.scopeSpans : []
  return {
    ...rs,
    scopeSpans: scopes.filter(isObj).map((ss) => ({ ...ss, spans: Array.isArray(ss.spans) ? ss.spans.filter(isComplete) : [] })),
  }
}

function csvParse(text: string): { fields: string[]; data: Record<string, unknown>[]; errors: Papa.ParseError[] } {
  const firstBreak = text.indexOf('\n')
  const header = (firstBreak < 0 ? text : text.slice(0, firstBreak)).replace(/\r$/, '')
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: guessDelimiter(header),
  })
  return { fields: result.meta.fields ?? [], data: result.data, errors: result.errors }
}

/** CSV rows as records, with the same line numbers and error records as the stream reader. */
function csvRecords(text: string, max: number, truncated: boolean): RawRecord[] {
  const { fields, data, errors } = csvParse(text)
  const rowErrors = new Map<number, string[]>()
  const loose: string[] = []
  for (const e of errors) {
    const msg = e.code ? `${e.code}: ${e.message}` : e.message
    const idx = typeof e.row === 'number' ? (e.code === 'TooFewFields' || e.code === 'TooManyFields' ? e.row : e.row - 1) : undefined
    if (idx !== undefined && idx >= 0 && idx < data.length) rowErrors.set(idx, [...(rowErrors.get(idx) ?? []), msg])
    else loose.push(msg)
  }
  let rows = data
  if (truncated && !/[\r\n]$/.test(text) && rows.length > 0) rows = rows.slice(0, -1)
  const out: RawRecord[] = []
  let nextLine = 2
  for (let i = 0; i < rows.length && out.length < max; i++) {
    const row = rows[i] ?? {}
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
    const extra = row.__parsed_extra
    if (Array.isArray(extra)) for (const v of extra) values.push(String(v))
    for (const v of values) nextLine += countLineBreaks(v)
    nextLine += 1
    const errs = rowErrors.get(i)
    if (errs) out.push({ kind: 'error', message: `Line ${line}: ${errs.join('; ')}`, raw: values.join(',').slice(0, RAW_KEEP), line })
    else out.push({ kind: 'csv', row: clean, line })
  }
  for (const msg of loose) if (out.length < max) out.push({ kind: 'error', message: msg, raw: '', line: null })
  return out
}

function jsonRecords(text: string, path: 'array' | 'data' | 'resourceSpans', max: number): RawRecord[] {
  let root: Prefix
  try {
    root = parseJsonPrefix(text)
  } catch (err) {
    return [{ kind: 'error', message: `Invalid JSON: ${(err as Error).message}`, raw: text.slice(0, 200), line: null }]
  }
  const list = path === 'array' ? root.value : isObj(root.value) ? root.value[path] : undefined
  if (!Array.isArray(list)) {
    const what = path === 'array' ? 'a JSON array' : `an object with a "${path}" array`
    return [{ kind: 'error', message: `Expected ${what}`, raw: text.trimStart().slice(0, 200), line: null }]
  }
  const values = path === 'resourceSpans' ? list.slice(0, max).map(trimResourceSpans) : completeElements(list, max)
  return values.map((value) => ({ kind: 'json' as const, value, line: null }))
}

/**
 * Records from the start of a file, read the way the stream reader for the variant reads them.
 * Used for previews and file-fact scans. When the text may be cut short (the default guess is
 * based on the 64 KiB sample size), a final partial record is dropped.
 */
export function sampleRecordsFromText(
  sampleText: string,
  variant: VariantId,
  max: number,
  opts: { truncated?: boolean } = {},
): RawRecord[] {
  if (max <= 0) return []
  const truncated = opts.truncated ?? looksTruncated(sampleText)
  const text = stripBom(sampleText)
  switch (formatForVariant(variant)) {
    case 'jsonl':
    case 'otlp-jsonl':
      return jsonlRecords(text, max, truncated)
    case 'json-array':
      return jsonRecords(text, 'array', max)
    case 'usage-page':
      return jsonRecords(text, 'data', max)
    case 'otlp':
      return jsonRecords(text, 'resourceSpans', max)
    case 'csv':
      return csvRecords(text, max, truncated)
  }
}

// ---------------------------------------------------------------------------
// Detection

interface Candidate {
  variant: VariantId
  score: number
  reason: string
  /** Lower wins a tie: 0 when the file extension fits the format. */
  priority: number
}

function extension(fileName: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim())
  return m?.[1]?.toLowerCase() ?? ''
}

function extensionFits(ext: string, format: StreamFormat): boolean {
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return format === 'csv'
  if (ext === 'jsonl' || ext === 'ndjson') return format === 'jsonl' || format === 'otlp-jsonl'
  if (ext === 'json') return format === 'json-array' || format === 'usage-page' || format === 'otlp'
  return false
}

/**
 * Median score of an adapter over sample records, so a few junk lines do not sink a good file.
 * Error records (lines that are not JSON) are skipped.
 */
function scoreAdapter(adapter: Adapter, records: RawRecord[]): { score: number; reason: string } {
  const usable = records.filter((r) => r.kind !== 'error').slice(0, SCORE_RECORDS)
  if (usable.length === 0) return { score: 0, reason: 'no readable records' }
  const scored = usable.map((r) => adapter.score(r)).sort((a, b) => a.score - b.score)
  const mid = scored.length >> 1
  const median = scored.length % 2 === 1 ? (scored[mid]?.score ?? 0) : ((scored[mid - 1]?.score ?? 0) + (scored[mid]?.score ?? 0)) / 2
  const best = scored[scored.length - 1]
  return { score: Math.round(median * 100) / 100, reason: best?.reason ?? '' }
}

function addCandidates(out: Candidate[], format: StreamFormat, records: RawRecord[], ext: string): void {
  for (const adapter of ADAPTERS) {
    const variants = adapter.variants.filter((v) => formatForVariant(v) === format)
    if (variants.length === 0) continue
    const s = scoreAdapter(adapter, records)
    for (const v of variants) {
      out.push({ variant: v, score: s.score, reason: s.reason, priority: extensionFits(ext, format) ? 0 : 1 })
    }
  }
}

function unsupported(detail: string, candidates: Candidate[] = [], csvHeaders: string[] | null = null): DetectionResult {
  return {
    variant: null,
    confidence: 0,
    reason: `${NOT_SUPPORTED}. ${detail}`,
    candidates: candidates.filter((c) => c.score > 0).map((c) => ({ variant: c.variant, confidence: c.score })),
    csvHeaders,
  }
}

function decide(candidates: Candidate[], containerText: string, csvHeaders: string[] | null): DetectionResult {
  const order = new Map(VARIANTS.map((v, i) => [v.id, i]))
  const sorted = [...candidates].sort(
    (a, b) => b.score - a.score || a.priority - b.priority || (order.get(a.variant) ?? 0) - (order.get(b.variant) ?? 0),
  )
  const best = sorted[0]
  if (!best || best.score < MIN_SCORE) {
    return unsupported(`The ${containerText} has no fields that a supported source writes.`, sorted, csvHeaders)
  }
  const label = VARIANTS.find((v) => v.id === best.variant)?.label ?? best.variant
  return {
    variant: best.variant,
    confidence: Math.min(1, Math.max(0, best.score)),
    reason: `${label}: ${best.reason}.`,
    candidates: sorted.filter((c) => c.score > 0).map((c) => ({ variant: c.variant, confidence: c.score })),
    csvHeaders,
  }
}

/** Header row as a record, so header-based scores do not depend on cell values. */
function headerRecord(fields: string[]): RawRecord {
  return { kind: 'csv', row: Object.fromEntries(fields.map((f) => [f, ''])), line: 1 }
}

function detectCsv(text: string, truncated: boolean, ext: string): DetectionResult {
  if (text.includes(String.fromCharCode(0))) return unsupported('The file looks binary.')
  const { fields, data, errors } = csvParse(text)
  const named = fields.filter((f) => f.trim() !== '')
  if (named.length < 2) return unsupported('The file is not JSON and not a CSV with a header row.')
  if (named.some((f) => f.length > 200)) return unsupported('The first line does not look like a CSV header row.')
  const rows = truncated && !/[\r\n]$/.test(text) ? Math.max(0, data.length - 1) : data.length
  const badRows = new Set(errors.map((e) => e.row)).size
  if (rows > 0 && badRows > rows / 2) {
    return unsupported('Most rows do not have the same number of columns as the header.', [], fields)
  }
  const candidates: Candidate[] = []
  addCandidates(candidates, 'csv', [headerRecord(fields)], ext)
  return decide(candidates, 'CSV header', fields)
}

function detectJsonValue(text: string, ext: string, truncated: boolean): DetectionResult {
  let first: Prefix
  try {
    first = parseJsonPrefix(text)
  } catch {
    return unsupported('The file starts like JSON but does not parse.')
  }
  const root = first.value
  const candidates: Candidate[] = []

  if (Array.isArray(root)) {
    const records = completeElements(root, SCORE_RECORDS).map((value) => ({ kind: 'json' as const, value, line: null }))
    if (records.length === 0) return unsupported('The JSON array is empty.')
    addCandidates(candidates, 'json-array', records, ext)
    return decide(candidates, 'JSON array', null)
  }

  if (!isObj(root)) return unsupported('The file holds a single JSON value that is not an object or array.')

  // More content after the first value means JSON Lines. A first value on one line may be either.
  const rest = first.cut ? '' : text.slice(first.end).trim()
  const singleLine = !text.slice(0, first.end).includes('\n')
  if (rest !== '' || singleLine) {
    // A single long line cut by the sample is scored from what parsed so far.
    const records: RawRecord[] = first.cut ? [{ kind: 'json', value: root, line: 1 }] : jsonlRecords(text, SCORE_RECORDS, truncated)
    addCandidates(candidates, 'jsonl', records, ext)
    addCandidates(candidates, 'otlp-jsonl', records, ext)
  }

  if (rest === '') {
    if (Array.isArray(root.resourceSpans)) {
      const records = root.resourceSpans.slice(0, SCORE_RECORDS).map((v) => ({ kind: 'json' as const, value: trimResourceSpans(v), line: null }))
      addObjectCandidates(candidates, 'otlp', records, ext)
    }
    if (Array.isArray(root.data)) {
      const records = completeElements(root.data, SCORE_RECORDS).map((value) => ({ kind: 'json' as const, value, line: null }))
      addObjectCandidates(candidates, 'usage-page', records, ext)
    }
  }

  if (candidates.length === 0) {
    return unsupported('A single JSON object is read only as an OTLP export request or a usage page. Use a JSON array or JSONL for other records.')
  }
  return decide(candidates, rest !== '' ? 'JSONL file' : 'JSON object', null)
}

/** Whole-document formats win a tie with JSONL, since the file is one JSON value. */
function addObjectCandidates(out: Candidate[], format: StreamFormat, records: RawRecord[], ext: string): void {
  const start = out.length
  addCandidates(out, format, records, ext)
  for (const c of out.slice(start)) c.priority -= 1
}

/**
 * Detect the input variant from the first 64 KiB of a file.
 * Returns variant null with a "not supported yet" reason when nothing plausible matches.
 */
export function detectFromSample(sampleText: string, fileName: string): DetectionResult {
  const truncated = looksTruncated(sampleText)
  const text = stripBom(sampleText.length > SAMPLE_BYTES ? sampleText.slice(0, SAMPLE_BYTES) : sampleText)
  const start = /\S/.exec(text)
  if (!start) return unsupported('The file is empty.')
  const ext = extension(fileName)
  const c = start[0]
  if (c === '[' || c === '{') return detectJsonValue(text.slice(start.index), ext, truncated)
  return detectCsv(text, truncated, ext)
}
