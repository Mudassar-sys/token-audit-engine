import type { CacheDuration, Flag, ReportedAmount, VariantId, TokenClasses } from '../contracts'
import { loggedNumberToDecimal } from '../money'
import type { Adapter, AdapterRow, RawRecord } from './types'
import { ZERO_CACHE_WRITE, at, malformedRow, tok, toUtcIso } from './types'

/**
 * Source F: LiteLLM spend logs (LiteLLM_SpendLogs rows), as CSV or a JSON array.
 * Cache, modality and reasoning tokens live in the metadata JSON. Whether prompt_tokens
 * already includes cached tokens is decided per row from its call type and usage shape,
 * because one proxy log can mix normalized rows with raw Anthropic rows.
 */

/** fileFacts key that carries the per-file summary of the row decisions (evidence only). */
export const LITELLM_INCLUSION_FACT = 'litellmCacheInclusion'

/** How one row's prompt_tokens relates to its cached tokens. */
export interface LiteLlmRowInclusion {
  /** included: prompt_tokens contains cache reads and writes. excluded: it does not. */
  mode: 'included' | 'excluded'
  /** detected: the call type, route or usage shape says so. assumed: no signal, documented default. */
  basis: 'detected' | 'assumed'
  /** Short reason for the mapping line. */
  reason: string
}

/** Summary of the per-row decisions over the scanned rows. Evidence only, never applied to rows. */
export interface LiteLlmInclusion {
  /** Decision shared by every scanned row with cached tokens, or mixed when rows differ. */
  mode: 'included' | 'excluded' | 'mixed'
  /** no_cache_tokens: nothing to decide. assumed: some row had no signal. detected: every row had one. */
  basis: 'detected' | 'assumed' | 'no_cache_tokens'
  rowsScanned: number
  rowsWithCache: number
  /** Rows with cached tokens decided as excluded (raw Anthropic usage). */
  rowsExcluded: number
  /** Rows decided as included whose cached tokens exceed prompt_tokens (Unresolved). */
  rowsContradicting: number
  evidence: string | null
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
/** Where LiteLLM keeps the cache write split by lifetime (normalized and Anthropic shapes). */
const TTL_BASES = ['prompt_tokens_details.cache_creation_token_details', 'cache_creation']
const TTLS: readonly CacheDuration[] = ['5m', '1h', '30m', '12h']
/** Counted but never priced. Input modality tokens are part of prompt_tokens, output ones of completion_tokens. */
const EXCLUDED_KEYS = {
  input_audio: 'prompt_tokens_details.audio_tokens',
  input_image: 'prompt_tokens_details.image_tokens',
  output_audio: 'completion_tokens_details.audio_tokens',
  output_image: 'completion_tokens_details.image_tokens',
  web_search_requests: 'server_tool_use.web_search_requests',
} as const
type ExcludedName = keyof typeof EXCLUDED_KEYS
const EXCLUDED_NAMES = Object.keys(EXCLUDED_KEYS) as ExcludedName[]

/** Call types whose usage LiteLLM normalizes to the OpenAI format, where prompt_tokens includes cache. */
const NORMALIZED_CALL_TYPES = new Set(['completion', 'acompletion', 'text_completion', 'atext_completion', 'responses', 'aresponses'])
/** Call types that create embeddings: billed for input only, so no output is expected. */
const EMBEDDING_CALL_TYPES = new Set(['embedding', 'aembedding'])
const PASS_THROUGH = /pass[_-]?through/i
/** Proxy routes that return raw Anthropic usage: the Anthropic pass-through and the /v1/messages endpoint. */
const RAW_ANTHROPIC_ROUTE = /(^|\/)anthropic\/v1\/messages|^\/?v1\/messages(\/|\?|$)/i

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

/** A cache write split by lifetime, read from one metadata location. */
interface TtlSplit {
  path: string
  values: Partial<Record<CacheDuration, number>>
  sum: number
}

/** Fields read from one spend log row, shared by the file scan and the main pass. */
interface Extracted {
  row: Record<string, unknown>
  raw: Record<string, unknown>
  bad: string[]
  meta: Record<string, unknown> | null
  prompt: number | null
  completion: number | null
  read: MetaValue[]
  write: MetaValue[]
  splits: TtlSplit[]
  reasoning: MetaValue[]
  excluded: Record<ExcludedName, MetaValue[]>
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

  /** One metadata count: undefined when absent, null when invalid (listed in bad). */
  const metaTok = (src: string, key: string): number | null | undefined => {
    if (!meta) return undefined
    const v = at(meta[src], key)
    if (v === undefined || v === null) return undefined
    const path = `metadata.${src}.${key}`
    raw[path] = v
    const n = tok(v)
    if (Number.isNaN(n) || n === null) {
      bad.push(path)
      return null
    }
    return n
  }

  const collect = (keys: readonly string[]): MetaValue[] => {
    const out: MetaValue[] = []
    for (const src of META_SOURCES) {
      for (const key of keys) {
        const n = metaTok(src, key)
        if (typeof n === 'number') out.push({ value: n, path: `metadata.${src}.${key}` })
      }
    }
    return out
  }

  const splits: TtlSplit[] = []
  for (const src of META_SOURCES) {
    for (const base of TTL_BASES) {
      const values: Partial<Record<CacheDuration, number>> = {}
      let found = false
      let sum = 0
      for (const ttl of TTLS) {
        const n = metaTok(src, `${base}.ephemeral_${ttl}_input_tokens`)
        if (n === undefined) continue
        found = true
        if (n === null) continue
        values[ttl] = n
        sum += n
      }
      if (found) splits.push({ path: `metadata.${src}.${base}`, values, sum })
    }
  }

  const excluded = {} as Record<ExcludedName, MetaValue[]>
  for (const name of EXCLUDED_NAMES) excluded[name] = collect([EXCLUDED_KEYS[name]])

  return {
    row,
    raw,
    bad,
    meta,
    prompt,
    completion,
    read: collect(READ_KEYS),
    write: collect(WRITE_KEYS),
    splits,
    reasoning: collect(REASONING_KEYS),
    excluded,
    metadataError: error,
  }
}

function first(values: MetaValue[]): number {
  return values[0]?.value ?? 0
}

/** Total cache writes: the logged total, else the sum of the lifetime split. */
function writeTotal(x: Extracted): number {
  if (x.write.length > 0) return first(x.write)
  return x.splits[0]?.sum ?? 0
}

/** Names of fields that report the same quantity with different values. */
function disagreement(values: MetaValue[]): string | null {
  const head = values[0]
  if (!head) return null
  const other = values.find((v) => v.value !== head.value)
  return other ? `${head.path} (${head.value}) differs from ${other.path} (${other.value})` : null
}

function splitText(s: TtlSplit): string {
  return TTLS.map((t) => `${t} ${s.values[t] ?? 0}`).join(', ')
}

/**
 * Decide for one row whether prompt_tokens includes cached tokens. LiteLLM's normalized
 * (OpenAI format) usage includes them. Raw Anthropic usage from /v1/messages or a
 * pass-through call leaves them out.
 */
export function litellmRowInclusion(row: Record<string, unknown>, meta: Record<string, unknown> | null): LiteLlmRowInclusion {
  const excluded = (reason: string): LiteLlmRowInclusion => ({ mode: 'excluded', basis: 'detected', reason })
  const callType = text(field(row, 'call_type'))
  const ct = callType?.toLowerCase() ?? ''
  if (ct.includes('anthropic_messages')) return excluded(`call_type ${callType} logs raw Anthropic usage`)
  if (PASS_THROUGH.test(ct)) return excluded(`call_type ${callType} is a pass-through call with raw provider usage`)
  const apiBase = text(field(row, 'api_base'))
  if (apiBase !== null && PASS_THROUGH.test(apiBase)) return excluded(`api_base ${apiBase} is a pass-through endpoint`)
  const route = meta ? text(meta.user_api_key_request_route) : null
  if (route !== null && (PASS_THROUGH.test(route) || RAW_ANTHROPIC_ROUTE.test(route))) {
    return excluded(`metadata.user_api_key_request_route ${route} returns raw provider usage`)
  }
  for (const src of META_SOURCES) {
    const u = meta?.[src]
    if (!isObj(u) || u.input_tokens == null || u.prompt_tokens_details != null) continue
    if (u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null) {
      return excluded(`metadata.${src} is raw Anthropic usage (input_tokens with cache fields, no prompt_tokens_details)`)
    }
  }
  if (NORMALIZED_CALL_TYPES.has(ct)) {
    return { mode: 'included', basis: 'detected', reason: `call_type ${callType} logs LiteLLM's normalized usage` }
  }
  for (const src of META_SOURCES) {
    const u = meta?.[src]
    if (isObj(u) && isObj(u.prompt_tokens_details)) {
      return { mode: 'included', basis: 'detected', reason: `metadata.${src}.prompt_tokens_details shows LiteLLM's normalized usage` }
    }
  }
  return {
    mode: 'included',
    basis: 'assumed',
    reason: `${callType === null ? 'no call_type' : `call_type ${callType} gives no signal`}, LiteLLM's documented default assumed`,
  }
}

/** Summarize the per-row decisions over the first rows of a file. Evidence only. */
export function scanLiteLlmInclusion(sample: RawRecord[]): LiteLlmInclusion {
  let rowsScanned = 0
  let rowsWithCache = 0
  let rowsExcluded = 0
  let rowsContradicting = 0
  let assumed = false
  let evidence: string | null = null
  const modes = new Set<'included' | 'excluded'>()
  for (const record of sample.slice(0, SCAN_LIMIT)) {
    const row = recordRow(record)
    if (!row) continue
    const x = extract(row)
    if (x.bad.length > 0 || x.prompt === null) continue
    rowsScanned++
    const cached = first(x.read) + writeTotal(x)
    if (cached === 0) continue
    rowsWithCache++
    const d = litellmRowInclusion(row, x.meta)
    modes.add(d.mode)
    if (d.basis === 'assumed') assumed = true
    if (d.mode === 'excluded') {
      rowsExcluded++
    } else if (cached > x.prompt) {
      rowsContradicting++
      const id = text(field(row, 'request_id'))
      evidence ??= `${id ? `request ${id}` : `row ${rowsScanned}`}: cache read ${first(x.read)} plus cache write ${writeTotal(x)} exceed prompt_tokens ${x.prompt} although ${d.reason}`
    }
  }
  return {
    mode: modes.size > 1 ? 'mixed' : modes.has('excluded') ? 'excluded' : 'included',
    basis: rowsWithCache === 0 ? 'no_cache_tokens' : assumed ? 'assumed' : 'detected',
    rowsScanned,
    rowsWithCache,
    rowsExcluded,
    rowsContradicting,
    evidence,
  }
}

/** Write duration when LiteLLM logs no TTL split. */
export function litellmWriteDuration(provider: string | null): CacheDuration {
  const p = (provider ?? '').toLowerCase()
  if (p === 'openai' || p === 'azure' || p === 'azure_ai' || p === 'text-completion-openai') return '30m'
  return '5m'
}

function normalize(record: RawRecord, variant: VariantId): AdapterRow {
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
  const callType = keep('call_type')
  keep('api_base')
  keep('status')
  keep('total_tokens')
  const model = keep('model')
  const provider = keep('custom_llm_provider')
  const startTime = keep('startTime')
  const spendText = keep('spend')
  const route = x.meta?.user_api_key_request_route
  if (route !== undefined) raw['metadata.user_api_key_request_route'] = route

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
  const flag = (f: Flag) => {
    if (!flags.includes(f)) flags.push(f)
  }

  if (x.metadataError) {
    unresolvedReason = `${x.metadataError}; cached tokens are unknown`
  }

  const cacheRead = first(x.read)
  const write = writeTotal(x)
  const reasoning = x.reasoning.length > 0 ? first(x.reasoning) : null
  const ex = (name: ExcludedName) => first(x.excluded[name])
  for (const values of [x.read, x.write, x.reasoning, ...EXCLUDED_NAMES.map((n) => x.excluded[n])]) {
    const d = disagreement(values)
    if (d) {
      flag('totals_disagree')
      unresolvedReason ??= `metadata usage fields disagree: ${d}`
    }
  }
  /** Mapping text for subtracted modality fields. */
  const minus = (names: ExcludedName[]) =>
    names
      .filter((n) => ex(n) > 0)
      .map((n) => ` - ${x.excluded[n][0]?.path} (excluded)`)
      .join('')

  const inclusion = litellmRowInclusion(row, x.meta)
  const cached = cacheRead + write
  const inModality = ex('input_audio') + ex('input_image')
  let uncached = 0
  if (x.prompt === null) {
    notMeasured.push('uncachedInput')
    mapping.push(`uncachedInput = not measured (prompt_tokens ${field(row, 'prompt_tokens') === undefined ? 'absent' : 'empty'})`)
  } else {
    const includes = inclusion.mode === 'included'
    const value = x.prompt - (includes ? cached : 0) - inModality
    mapping.push(
      `uncachedInput = prompt_tokens${includes ? ' - cache read - cache write' : ''}${minus(['input_audio', 'input_image'])} (prompt_tokens ${includes ? 'includes' : 'excludes'} cached tokens: ${inclusion.reason})`,
    )
    if (cached > 0) flag(inclusion.basis === 'assumed' ? 'inclusion_assumed' : 'inclusion_detected')
    if (value >= 0) {
      uncached = value
    } else if (includes && cached > x.prompt) {
      flag('cache_exceeds_input')
      unresolvedReason ??= `cache tokens (${cached}) exceed prompt_tokens (${x.prompt}), which contradicts the row's inclusion decision (${inclusion.reason})`
    } else if (includes) {
      flag('cache_exceeds_input')
      unresolvedReason ??= `cache, audio and image tokens (${cached + inModality}) exceed prompt_tokens (${x.prompt})`
    } else {
      flag('totals_disagree')
      unresolvedReason ??= `audio and image tokens (${inModality}) exceed prompt_tokens (${x.prompt})`
    }
  }

  if (x.read.length === 0) notMeasured.push('cacheRead')
  else mapping.push(`cacheRead = ${x.read[0]?.path}`)

  const cacheWrite: TokenClasses['cacheWrite'] = { ...ZERO_CACHE_WRITE }
  const split = x.splits[0]
  if (split) {
    for (const ttl of TTLS) {
      const v = split.values[ttl] ?? 0
      cacheWrite[ttl] = v
      if (v > 0) mapping.push(`cacheWrite.${ttl} = ${split.path}.ephemeral_${ttl}_input_tokens`)
    }
    if (split.sum === 0) mapping.push(`cacheWrite = ${split.path} (every lifetime 0)`)
    const other = x.splits.find((s) => TTLS.some((t) => (s.values[t] ?? 0) !== (split.values[t] ?? 0)))
    if (other) {
      flag('totals_disagree')
      unresolvedReason ??= `cache write splits disagree: ${split.path} (${splitText(split)}) differs from ${other.path} (${splitText(other)})`
    }
    const total = x.write[0]
    if (total && total.value !== split.sum) {
      flag('totals_disagree')
      unresolvedReason ??= `cache write split ${split.path} sums to ${split.sum} but ${total.path} is ${total.value}`
    }
  } else if (x.write.length === 0) {
    notMeasured.push('cacheWrite')
  } else {
    const d = litellmWriteDuration(provider)
    cacheWrite[d] = write
    mapping.push(`cacheWrite.${d} = ${x.write[0]?.path} (no duration split, ${d} assumed from custom_llm_provider)`)
    if (write > 0) flag('duration_assumed')
  }

  const embedding = callType !== null && EMBEDDING_CALL_TYPES.has(callType.toLowerCase())
  if (embedding) mapping.push(`operation = embedding (call_type ${callType}), billed for input only`)

  let output = 0
  if (x.completion === null) {
    notMeasured.push('output')
    mapping.push(`output = not measured (completion_tokens ${field(row, 'completion_tokens') === undefined ? 'absent' : 'empty'})`)
  } else {
    const value = x.completion - ex('output_audio') - ex('output_image')
    mapping.push(`output = completion_tokens${minus(['output_audio', 'output_image'])} (includes reasoning tokens)`)
    if (value >= 0) {
      output = value
    } else {
      flag('totals_disagree')
      unresolvedReason ??= `audio and image output tokens exceed completion_tokens (${x.completion})`
    }
  }

  if (reasoning === null) notMeasured.push('reasoning')
  else {
    mapping.push(`reasoning = ${x.reasoning[0]?.path} (part of output, never added)`)
    if (x.completion !== null && reasoning > output) {
      flag('totals_disagree')
      unresolvedReason ??= `reasoning tokens (${reasoning}) exceed text output tokens (${output})`
    }
  }

  const excluded: Record<string, number> = {}
  for (const name of EXCLUDED_NAMES) {
    const v = ex(name)
    if (v <= 0) continue
    excluded[name] = v
    mapping.push(`excluded.${name} = ${x.excluded[name][0]?.path} (counted, not priced)`)
  }
  if (reported) mapping.push('reported gateway estimate = spend')

  if (model === null) flag('model_missing')

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
      output,
      reasoning,
    },
    notMeasured,
    excluded,
    reported,
    raw,
    mapping,
    flags,
    unresolvedReason,
    counted: true,
    requests: 1,
    ...(embedding ? { operation: 'embedding' as const } : {}),
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
  version: '1.2.0',
  variants: ['F-csv', 'F-json'],
  label: 'LiteLLM spend logs',
  score: scoreSpendLog,
  scanFileFacts(sample) {
    return { [LITELLM_INCLUSION_FACT]: scanLiteLlmInclusion(sample) }
  },
  begin(ctx) {
    // Inclusion is decided per row, so the file summary in ctx.fileFacts is not applied.
    return {
      push: (record) => [normalize(record, ctx.variant)],
      finish: () => [],
    }
  },
}
