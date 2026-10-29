import type { CustomCsvMapping, NormalizedUsageRow, SourceId, VariantId } from '../contracts'

/** A row as an adapter emits it. The pipeline assigns rowIndex in stream order. */
export type AdapterRow = Omit<NormalizedUsageRow, 'rowIndex'>

/** One record handed to an adapter by a stream reader. */
export type RawRecord =
  | { kind: 'json'; value: unknown; line: number | null }
  | { kind: 'csv'; row: Record<string, string>; line: number }
  | { kind: 'error'; message: string; raw: string; line: number | null }

export interface AdapterContext {
  variant: VariantId
  mapping: CustomCsvMapping | null
  /** File-level facts found before the main pass (for example LiteLLM cached-token inclusion). */
  fileFacts: Record<string, unknown>
}

export interface AdapterRun {
  /** Normalize one record into zero or more rows. Must not throw on bad data: emit a malformed row. */
  push(record: RawRecord): AdapterRow[]
  /** Called once at end of stream. Adapters that need whole-file context (OTLP span trees) emit here. */
  finish(): AdapterRow[]
}

export interface Adapter {
  source: SourceId
  /** Stable adapter id and version, both part of the calculation identity. */
  id: string
  version: string
  variants: readonly VariantId[]
  /** Human label shown in the supported variants list. */
  label: string
  /**
   * Score how well a sample record matches this source, 0..1, with a short reason.
   * For CSV sources the record is { kind: 'csv' } with the header row as keys.
   */
  score(sample: RawRecord): { score: number; reason: string }
  /**
   * Optional pre-pass over a sample of records (for example the first 5,000) that fixes
   * file-level facts before the main pass.
   */
  scanFileFacts?(sample: RawRecord[]): Record<string, unknown>
  begin(ctx: AdapterContext): AdapterRun
}

export const ZERO_CACHE_WRITE = { '5m': 0, '1h': 0, '30m': 0, '12h': 0 } as const

/** Read a non-negative integer token count; null when absent; NaN when present but invalid. */
export function tok(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(n) && n >= 0 ? n : NaN
}

/** Build a malformed row that keeps the raw text and is labelled Unresolved downstream. */
export function malformedRow(variant: VariantId, reason: string, raw: unknown): AdapterRow {
  return {
    timestamp: null,
    variant,
    provider: null,
    modelLogged: null,
    tierStated: null,
    granularity: 'request',
    tokens: { uncachedInput: 0, cacheRead: 0, cacheWrite: { ...ZERO_CACHE_WRITE }, output: 0, reasoning: null },
    notMeasured: [],
    excluded: {},
    reported: null,
    raw: { record: typeof raw === 'string' ? raw.slice(0, 2000) : raw },
    mapping: [],
    flags: ['malformed'],
    unresolvedReason: `Malformed: ${reason}`,
    counted: true,
    requests: 1,
  }
}

/** Get a nested value by dotted path. */
export function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Convert epoch seconds, epoch milliseconds, epoch nanoseconds or an ISO string into UTC ISO text. */
export function toUtcIso(value: unknown, unit: 's' | 'ms' | 'ns' | 'auto' = 'auto'): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    const d = new Date(value.includes('T') || value.includes(' ') ? value.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? '' : 'Z') : value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  const str = String(value).trim()
  let ms: number
  if (unit === 'ns' || (unit === 'auto' && str.length >= 18)) ms = Number(BigInt(str) / 1000000n)
  else if (unit === 'ms' || (unit === 'auto' && str.length >= 13)) ms = Number(str)
  else ms = Number(str) * 1000
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
