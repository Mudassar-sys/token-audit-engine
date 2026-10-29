import type { CacheDuration, Flag, ReportedAmount, VariantId, TokenClasses } from '../contracts'
import { loggedNumberToDecimal } from '../money'
import type { Adapter, AdapterRow, RawRecord } from './types'
import { ZERO_CACHE_WRITE, at, malformedRow, tok, toUtcIso } from './types'

/**
 * Source F: LiteLLM spend logs (LiteLLM_SpendLogs rows), as CSV or a JSON array.
 * Cache and reasoning tokens live in the metadata JSON. Whether prompt_tokens already
 * includes cached tokens is decided once per file by scanFileFacts.
 */

/** fileFacts key that carries the per-file inclusion decision. */
export const LITELLM_INCLUSION_FACT = 'litellmCacheInclusion'

export interface LiteLlmInclusion {
  /** included: prompt_tokens contains cache reads and writes. excluded: it does not. */
  mode: 'included' | 'excluded'
  /** detected: a row proves exclusion. assumed: documented default. no_cache_tokens: nothing to decide. */
  basis: 'detected' | 'assumed' | 'no_cache_tokens'
  rowsScanned: number
  rowsWithCache: number
  evidence: string | null
}

const DEFAULT_INCLUSION: LiteLlmInclusion = {
  mode: 'included',
  basis: 'assumed',
  rowsScanned: 0,
  rowsWithCache: 0,
  evidence: null,
}

const SCAN_LIMIT = 5000
const META_SOURCES = ['additional_usage_values', 'usage_object'] as const
const READ_KEYS = ['cache_read_input_tokens', 'prompt_tokens_details.cached_tokens']
const WRITE_KEYS = [
  'cache_creation_input_tokens',
  'prompt_tokens_details.cache_write_tokens',
  'prompt_tokens_details.cache_creation_tokens',
]
const REASONING_KEYS = ['completion_tokens_details.reasoning_tokens']

const CORE_COLUMNS = ['request_id', 'spend', 'prompt_tokens', 'completion_tokens', 'model', 'startTime']
const EXTRA_COLUMNS = [
  'call_type',
  'api_key',
  'total_tokens',
  'endTime',
  'custom_llm_provider',
  'metadata',
  'model_group',
  'cache_hit',
]

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Read a column by name, falling back to a case-insensitive match. */
function field(row: Record<string, unknown>, name: string): unknown {
  if (name in row) return row[name]
  const lower = name.toLowerCase()
  for (const k of Object.keys(row)) if (k.toLowerCase() === lower) return row[k]
  return undefined
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = typeof v === 'string' ? v.trim() : String(v)
  return s === '' ? null : s
}

interface MetaValue {
  value: number
  path: string
}

/** Fields read from one spend log row, shared by the file scan and the main pass. */
interface Extracted {
  row: Record<string, unknown>
  raw: Record<string, unknown>
  bad: string[]
  prompt: number | null
  completion: number | null
  read: MetaValue[]
  write: MetaValue[]
  reasoning: MetaValue[]
  metadataError: string | null
}

function parseMetadata(v: unknown): { meta: Record<string, unknown> | null; error: string | null } {
  if (isObj(v)) return { meta: v, error: null }
  const s = text(v)
  if (s === null) return { meta: null, error: null }
  try {
    const parsed: unknown = JSON.parse(s)
    if (isObj(parsed)) return { meta: parsed, error: null }
    if (parsed === null) return { meta: null, error: null }
    return { meta: null, error: 'metadata is not a JSON object' }
  } catch {
    return { meta: null, error: 'metadata is not valid JSON' }
  }
}

function recordRow(record: RawRecord): Record<string, unknown> | null {
  if (record.kind === 'csv') return record.row
  if (record.kind === 'json' && isObj(record.value)) return record.value
  return null
}

function extract(row: Record<string, unknown>): Extracted {
  const raw: Record<string, unknown> = {}
  const bad: string[] = []
  const col = (name: string): unknown => {
    const v = field(row, name)
    if (v !== undefined) raw[name] = v
    return v
  }
  const num = (name: string): number | null => {
    const n = tok(col(name))
    if (Number.isNaN(n)) {
      bad.push(name)
      return null
    }
    return n
  }
  const prompt = num('prompt_tokens')
  const completion = num('completion_tokens')
  const { meta, error } = parseMetadata(field(row, 'metadata'))

  const collect = (keys: string[]): MetaValue[] => {
    const out: MetaValue[] = []
    if (!meta) return out
    for (const src of META_SOURCES) {
      for (const key of keys) {
        const v = at(meta[src], key)
        if (v === undefined || v === null) continue
        const path = `metadata.${src}.${key}`
        raw[path] = v
        const n = tok(v)
        if (Number.isNaN(n) || n === null) bad.push(path)
        else out.push({ value: n, path })
      }
    }
    return out
  }

  return {
    row,
    raw,
    bad,
    prompt,
    completion,
    read: collect(READ_KEYS),
    write: collect(WRITE_KEYS),
    reasoning: collect(REASONING_KEYS),
    metadataError: error,
  }
}

function first(values: MetaValue[]): number {
  return values[0]?.value ?? 0
}

/** Names of fields that report the same quantity with different values. */
function disagreement(values: MetaValue[]): string | null {
  const head = values[0]
  if (!head) return null
  const other = values.find((v) => v.value !== head.value)
  return other ? `${head.path} (${head.value}) differs from ${other.path} (${other.value})` : null
}

/** Decide once per file whether prompt_tokens includes cached tokens. */
export function scanLiteLlmInclusion(sample: RawRecord[]): LiteLlmInclusion {
  let rowsScanned = 0
  let rowsWithCache = 0
  for (const record of sample.slice(0, SCAN_LIMIT)) {
    const row = recordRow(record)
    if (!row) continue
    const x = extract(row)
    if (x.bad.length > 0 || x.prompt === null) continue
    rowsScanned++
    const cached = first(x.read) + first(x.write)
    if (cached === 0) continue
    rowsWithCache++
    if (cached > x.prompt) {
      const id = text(field(row, 'request_id'))
      return {
        mode: 'excluded',
        basis: 'detected',
        rowsScanned,
        rowsWithCache,
        evidence: `${id ? `request ${id}` : `row ${rowsScanned}`}: cache read ${first(x.read)} plus cache write ${first(x.write)} exceed prompt_tokens ${x.prompt}`,
      }
    }
  }
  return rowsWithCache > 0
    ? { mode: 'included', basis: 'assumed', rowsScanned, rowsWithCache, evidence: null }
    : { mode: 'included', basis: 'no_cache_tokens', rowsScanned, rowsWithCache, evidence: null }
}

/** Write duration when LiteLLM logs no TTL split. */
export function litellmWriteDuration(provider: string | null): CacheDuration {
  const p = (provider ?? '').toLowerCase()
  if (p === 'openai' || p === 'azure' || p === 'azure_ai' || p === 'text-completion-openai') return '30m'
  return '5m'
}

function readInclusion(facts: Record<string, unknown>): LiteLlmInclusion {
  const f = facts[LITELLM_INCLUSION_FACT]
  if (isObj(f) && (f.mode === 'included' || f.mode === 'excluded')) return f as unknown as LiteLlmInclusion
  return DEFAULT_INCLUSION
}

function normalize(record: RawRecord, variant: VariantId, inclusion: LiteLlmInclusion): AdapterRow {
  if (record.kind === 'error') return malformedRow(variant, record.message, record.raw)
  const row = recordRow(record)
  if (!row) return malformedRow(variant, 'record is not a spend log object', record.kind === 'json' ? safeJson(record.value) : '')

  const x = extract(row)
  const raw = x.raw
  const keep = (name: string): string | null => {
    const v = field(row, name)
    if (v !== undefined) raw[name] = v
    return text(v)
  }
  keep('request_id')
  keep('call_type')
  keep('status')
  keep('total_tokens')
  const model = keep('model')
  const provider = keep('custom_llm_provider')
  const startTime = keep('startTime')
  const spendText = keep('spend')

  if (x.bad.length > 0) return malformedRow(variant, `${x.bad.join(', ')} is not a non-negative integer`, rowText(record))

  let reported: ReportedAmount | null = null
  if (spendText !== null) {
    let amount: string | null
    try {
      amount = loggedNumberToDecimal(spendText)
    } catch {
      amount = null
    }
    if (amount === null) return malformedRow(variant, `spend "${spendText}" is not a number`, rowText(record))
    reported = { amountUsd: amount, field: 'spend', kind: 'gateway_estimate' }
  }

  const flags: Flag[] = []
  const notMeasured: string[] = []
  const mapping: string[] = []
  let unresolvedReason: string | null = null

  if (x.metadataError) {
    unresolvedReason = `${x.metadataError}; cached tokens are unknown`
  }

  const cacheRead = first(x.read)
  const write = first(x.write)
  const reasoning = x.reasoning.length > 0 ? first(x.reasoning) : null
  for (const values of [x.read, x.write, x.reasoning]) {
    const d = disagreement(values)
    if (d) {
      if (!flags.includes('totals_disagree')) flags.push('totals_disagree')
      unresolvedReason ??= `metadata usage fields disagree: ${d}`
    }
  }

  const cached = cacheRead + write
  let uncached = 0
  if (x.prompt === null) {
    notMeasured.push('uncachedInput')
  } else if (inclusion.mode === 'excluded') {
    uncached = x.prompt
    mapping.push('uncachedInput = prompt_tokens (this file logs cached tokens outside prompt_tokens)')
    if (cached > 0) flags.push('inclusion_detected')
  } else {
    uncached = x.prompt - cached
    mapping.push('uncachedInput = prompt_tokens - cache read - cache write (prompt_tokens includes cached tokens)')
    if (cached > 0) flags.push(inclusion.basis === 'detected' ? 'inclusion_detected' : 'inclusion_assumed')
    if (uncached < 0) {
      uncached = 0
      flags.push('cache_exceeds_input')
      unresolvedReason ??= `cache tokens (${cached}) exceed prompt_tokens (${x.prompt}), which contradicts the file-level inclusion decision`
    }
  }

  if (x.read.length === 0) notMeasured.push('cacheRead')
  else mapping.push(`cacheRead = ${x.read[0]?.path}`)

  const cacheWrite: TokenClasses['cacheWrite'] = { ...ZERO_CACHE_WRITE }
  if (x.write.length === 0) {
    notMeasured.push('cacheWrite')
  } else {
    const d = litellmWriteDuration(provider)
    cacheWrite[d] = write
    mapping.push(`cacheWrite.${d} = ${x.write[0]?.path} (no duration split, ${d} assumed from custom_llm_provider)`)
    if (write > 0) flags.push('duration_assumed')
  }

  if (x.completion === null) notMeasured.push('output')
  else mapping.push('output = completion_tokens (includes reasoning tokens)')

  if (reasoning === null) notMeasured.push('reasoning')
  else {
    mapping.push(`reasoning = ${x.reasoning[0]?.path} (part of output, never added)`)
    if (x.completion !== null && reasoning > x.completion) {
      if (!flags.includes('totals_disagree')) flags.push('totals_disagree')
      unresolvedReason ??= `reasoning tokens (${reasoning}) exceed completion_tokens (${x.completion})`
    }
  }
  if (reported) mapping.push('reported gateway estimate = spend')

  if (model === null) flags.push('model_missing')

  return {
    timestamp: toUtcIso(startTime),
    variant,
    provider,
    modelLogged: model,
    tierStated: null,
    granularity: 'request',
    tokens: {
      uncachedInput: uncached,
      cacheRead,
      cacheWrite,
      output: x.completion ?? 0,
      reasoning,
    },
    notMeasured,
    excluded: {},
    reported,
    raw,
    mapping,
    flags,
    unresolvedReason,
    counted: true,
    requests: 1,
  }
}

/** Columns that hold whole prompts or responses. Kept out of raw. */
const CONTENT_COLUMNS = new Set(['messages', 'response', 'proxy_server_request'])

/** Raw text of a malformed row without prompt or response content. */
function rowText(record: RawRecord): string {
  if (record.kind === 'error') return record.raw
  const row = recordRow(record)
  if (!row) return ''
  const kept: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!CONTENT_COLUMNS.has(k.toLowerCase())) kept[k] = v
  return safeJson(kept)
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

function scoreSpendLog(sample: RawRecord): { score: number; reason: string } {
  const row = recordRow(sample)
  if (!row) return { score: 0, reason: 'not a CSV row or JSON object' }
  const keys = new Set(Object.keys(row).map((k) => k.toLowerCase()))
  const has = (c: string) => keys.has(c.toLowerCase())
  const core = CORE_COLUMNS.filter(has).length / CORE_COLUMNS.length
  const extra = EXTRA_COLUMNS.filter(has).length / EXTRA_COLUMNS.length
  if (!has('spend') || !has('prompt_tokens') || !has('completion_tokens')) {
    return { score: Math.min(0.3, 0.3 * core), reason: 'no spend, prompt_tokens and completion_tokens columns' }
  }
  const score = Math.round((0.7 * core + 0.3 * extra) * 100) / 100
  return { score, reason: `LiteLLM spend log columns (${Math.round(core * 100)}% of core columns present)` }
}

export const litellmAdapter: Adapter = {
  source: 'F',
  id: 'litellm-spend-logs',
  version: '1.0.0',
  variants: ['F-csv', 'F-json'],
  label: 'LiteLLM spend logs',
  score: scoreSpendLog,
  scanFileFacts(sample) {
    return { [LITELLM_INCLUSION_FACT]: scanLiteLlmInclusion(sample) }
  },
  begin(ctx) {
    const inclusion = readInclusion(ctx.fileFacts)
    return {
      push: (record) => [normalize(record, ctx.variant, inclusion)],
      finish: () => [],
    }
  },
}
