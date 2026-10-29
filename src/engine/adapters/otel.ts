import type { CacheDuration, Flag, Tier, VariantId, TokenClasses } from '../contracts'
import type { Adapter, AdapterRow, RawRecord } from './types'
import { ZERO_CACHE_WRITE, malformedRow, tok, toUtcIso } from './types'
import { RowNotes, readServiceTier } from './openaiChat'

/**
 * Source G: OpenTelemetry GenAI spans in OTLP JSON.
 * A record is an export request. For G-otlp the reader emits one per span, holding that span
 * with its resource and scope; for G-otlp-jsonl it is one whole line.
 * Spans are buffered as compact records and classified in finish(), once the span tree is known.
 */

/** Operations whose usage is a model call and is counted. */
const INFERENCE_OPS = new Set(['chat', 'text_completion', 'generate_content', 'embeddings'])
/** The embeddings operation is billed for input only, so no output is expected. */
const EMBEDDINGS_OP = 'embeddings'

const K = {
  input: 'gen_ai.usage.input_tokens',
  output: 'gen_ai.usage.output_tokens',
  prompt: 'gen_ai.usage.prompt_tokens',
  completion: 'gen_ai.usage.completion_tokens',
  cacheRead: 'gen_ai.usage.cache_read.input_tokens',
  cacheWrite: 'gen_ai.usage.cache_write.input_tokens',
  cacheCreation: 'gen_ai.usage.cache_creation.input_tokens',
  reasoning: 'gen_ai.usage.reasoning.output_tokens',
  imageIn: 'gen_ai.usage.image.input_tokens',
  audioIn: 'gen_ai.usage.audio.input_tokens',
  imageCacheRead: 'gen_ai.usage.image.cache_read.input_tokens',
  audioCacheRead: 'gen_ai.usage.audio.cache_read.input_tokens',
  imageOut: 'gen_ai.usage.image.output_tokens',
  audioOut: 'gen_ai.usage.audio.output_tokens',
} as const

const TOKEN_KEYS: readonly string[] = Object.values(K)
/** Keys whose presence means the span reports usage. */
const USAGE_KEYS = [K.input, K.output, K.prompt, K.completion, K.cacheRead, K.cacheWrite, K.cacheCreation, K.reasoning]
const TEXT_KEYS = [
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.system',
  'gen_ai.response.model',
  'gen_ai.request.model',
  'gen_ai.response.id',
  'gen_ai.conversation.id',
  'gen_ai.agent.name',
  'openai.response.service_tier',
  'gen_ai.openai.response.service_tier',
]

/** Tiers an OpenAI service_tier attribute may state (Chat Completions and Responses values). */
const OTEL_TIERS: readonly Tier[] = ['standard', 'flex', 'priority', 'ultrafast']

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Decode an OTLP AnyValue into a plain value. intValue may be a decimal string or a number. */
export function anyValue(v: unknown): unknown {
  if (!isObj(v)) return undefined
  if ('stringValue' in v) return v.stringValue
  if ('intValue' in v) return v.intValue
  if ('doubleValue' in v) return v.doubleValue
  if ('boolValue' in v) return v.boolValue
  if ('bytesValue' in v) return v.bytesValue
  if ('arrayValue' in v) {
    const values = isObj(v.arrayValue) && Array.isArray(v.arrayValue.values) ? v.arrayValue.values : []
    return values.map(anyValue)
  }
  if ('kvlistValue' in v) {
    const values = isObj(v.kvlistValue) && Array.isArray(v.kvlistValue.values) ? v.kvlistValue.values : []
    const out: Record<string, unknown> = {}
    for (const kv of values) if (isObj(kv) && typeof kv.key === 'string') out[kv.key] = anyValue(kv.value)
    return out
  }
  return undefined
}

function attributes(list: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (!Array.isArray(list)) return out
  for (const kv of list) if (isObj(kv) && typeof kv.key === 'string') out.set(kv.key, anyValue(kv.value))
  return out
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** Usage numbers read from one span. */
interface SpanUsage {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  cacheCreation: number | null
  reasoning: number | null
  imageIn: number | null
  audioIn: number | null
  imageCacheRead: number | null
  audioCacheRead: number | null
  imageOut: number | null
  audioOut: number | null
  inputKey: string
  outputKey: string
}

/** Compact record kept per span until finish(). */
interface SpanEntry {
  key: string
  parentKey: string | null
  usage: SpanUsage | null
  bad: string[]
  op: string | null
  provider: string | null
  model: string | null
  start: unknown
  /** service_tier attribute value and the key it was read from, or null when the span states none. */
  tier: { key: string; value: unknown } | null
  raw: Record<string, unknown>
  /** Same traceId and spanId as an earlier span with usage. */
  duplicate: boolean
}

type Entry = { kind: 'span'; span: SpanEntry } | { kind: 'malformed'; row: AdapterRow }

function readUsage(attrs: Map<string, unknown>, raw: Record<string, unknown>, bad: string[]): SpanUsage | null {
  if (!USAGE_KEYS.some((k) => attrs.has(k))) return null
  const vals = new Map<string, number>()
  for (const key of TOKEN_KEYS) {
    if (!attrs.has(key)) continue
    const v = attrs.get(key)
    raw[key] = v
    const t = tok(v)
    if (Number.isNaN(t)) bad.push(key)
    else if (t !== null) vals.set(key, t)
  }
  const n = (key: string): number | null => vals.get(key) ?? null
  const legacyIn = !vals.has(K.input) && vals.has(K.prompt)
  const legacyOut = !vals.has(K.output) && vals.has(K.completion)
  return {
    input: legacyIn ? n(K.prompt) : n(K.input),
    output: legacyOut ? n(K.completion) : n(K.output),
    cacheRead: n(K.cacheRead),
    cacheWrite: n(K.cacheWrite),
    cacheCreation: n(K.cacheCreation),
    reasoning: n(K.reasoning),
    imageIn: n(K.imageIn),
    audioIn: n(K.audioIn),
    imageCacheRead: n(K.imageCacheRead),
    audioCacheRead: n(K.audioCacheRead),
    imageOut: n(K.imageOut),
    audioOut: n(K.audioOut),
    inputKey: legacyIn ? K.prompt : K.input,
    outputKey: legacyOut ? K.completion : K.output,
  }
}

/** Cache write duration when spans carry no TTL split. */
export function otelWriteDuration(provider: string | null): CacheDuration {
  const p = (provider ?? '').toLowerCase()
  if (p === 'openai' || p === 'azure.ai.openai') return '30m'
  return '5m'
}

/** Build a row from a span's own usage. Tree checks are applied afterwards. */
function spanRow(s: SpanEntry, u: SpanUsage, variant: VariantId): AdapterRow {
  const flags: Flag[] = []
  const notMeasured: string[] = []
  const mapping: string[] = []
  let unresolvedReason: string | null = null

  const read = u.cacheRead ?? 0
  let write = 0
  let writeKey: string | null = null
  if (u.cacheWrite !== null && u.cacheCreation !== null && u.cacheWrite !== u.cacheCreation) {
    flags.push('totals_disagree')
    unresolvedReason = `${K.cacheWrite} (${u.cacheWrite}) differs from ${K.cacheCreation} (${u.cacheCreation})`
  }
  if (u.cacheWrite !== null) {
    write = u.cacheWrite
    writeKey = K.cacheWrite
  } else if (u.cacheCreation !== null) {
    write = u.cacheCreation
    writeKey = K.cacheCreation
  }

  const imageIn = u.imageIn ?? 0
  const audioIn = u.audioIn ?? 0
  const imageCached = u.imageCacheRead ?? 0
  const audioCached = u.audioCacheRead ?? 0
  const imageOut = u.imageOut ?? 0
  const audioOut = u.audioOut ?? 0

  const excluded: Record<string, number> = {}
  if (imageIn > 0) excluded.input_image = imageIn
  if (audioIn > 0) excluded.input_audio = audioIn
  if (imageOut > 0) excluded.output_image = imageOut
  if (audioOut > 0) excluded.output_audio = audioOut

  let uncached = 0
  let cacheRead = read
  if (u.input === null) {
    notMeasured.push('uncachedInput')
    mapping.push(`uncachedInput = not measured (${K.input} absent)`)
  } else if (read + write > u.input) {
    flags.push('cache_exceeds_input')
    unresolvedReason ??= 'cache tokens exceed input tokens; no documented producer rule'
    mapping.push(`uncachedInput = ${u.inputKey} - cache read - cache write (negative: ${u.input} - ${read} - ${write})`)
  } else {
    const modality = imageIn - imageCached + (audioIn - audioCached)
    uncached = u.input - read - write - modality
    cacheRead = read - imageCached - audioCached
    let line = `uncachedInput = ${u.inputKey} - ${K.cacheRead} - ${writeKey ?? K.cacheWrite}`
    if (modality > 0) line += ' - uncached image and audio input tokens (excluded)'
    mapping.push(line)
    if (uncached < 0 || cacheRead < 0) {
      uncached = Math.max(uncached, 0)
      cacheRead = Math.max(cacheRead, 0)
      flags.push('totals_disagree')
      unresolvedReason ??= 'image and audio input tokens exceed the input token totals they belong to'
    }
  }

  if (u.cacheRead === null) notMeasured.push('cacheRead')
  else mapping.push(`cacheRead = ${K.cacheRead}${imageCached + audioCached > 0 ? ' - image and audio cache reads (excluded)' : ''}`)

  const cacheWrite: TokenClasses['cacheWrite'] = { ...ZERO_CACHE_WRITE }
  if (writeKey === null) {
    notMeasured.push('cacheWrite')
  } else {
    const d = otelWriteDuration(s.provider)
    cacheWrite[d] = write
    mapping.push(`cacheWrite.${d} = ${writeKey} (no duration split, ${d} assumed from the provider)`)
    if (write > 0) flags.push('duration_assumed')
  }

  let output = 0
  if (u.output === null) {
    notMeasured.push('output')
    mapping.push(`output = not measured (${K.output} absent)`)
  } else {
    output = u.output - imageOut - audioOut
    mapping.push(`output = ${u.outputKey}${imageOut + audioOut > 0 ? ' - image and audio output tokens (excluded)' : ''}`)
    if (output < 0) {
      output = 0
      flags.push('totals_disagree')
      unresolvedReason ??= 'image and audio output tokens exceed the output token total'
    }
  }

  if (u.reasoning === null) notMeasured.push('reasoning')
  else {
    mapping.push(`reasoning = ${K.reasoning} (part of output, never added)`)
    if (u.output !== null && u.reasoning > u.output) {
      if (!flags.includes('totals_disagree')) flags.push('totals_disagree')
      unresolvedReason ??= `reasoning tokens (${u.reasoning}) exceed output tokens (${u.output})`
    }
  }

  let tierStated: Tier | null = null
  const raw = { ...s.raw }
  if (s.tier !== null) {
    // Same mapping as the OpenAI response adapters: fast => priority, ultrafast as stated,
    // scale kept in raw for pricing, anything else Unresolved.
    const notes = new RowNotes()
    tierStated = readServiceTier(s.tier.value, s.tier.key, OTEL_TIERS, notes)
    mapping.push(...notes.mapping)
    const reason = notes.reason()
    if (reason !== null) unresolvedReason = unresolvedReason === null ? reason : `${unresolvedReason}; ${reason}`
    if (s.tier.value === 'scale') raw.service_tier = 'scale'
  }

  if (s.model === null) flags.push('model_missing')
  const embedding = s.op === EMBEDDINGS_OP
  if (embedding) mapping.push('operation = embedding (gen_ai.operation.name "embeddings"), billed for input only')

  return {
    timestamp: safeIso(s.start),
    variant,
    provider: s.provider,
    modelLogged: s.model,
    tierStated,
    granularity: 'request',
    tokens: { uncachedInput: uncached, cacheRead, cacheWrite, output, reasoning: u.reasoning },
    notMeasured,
    excluded,
    reported: null,
    raw,
    mapping,
    flags,
    unresolvedReason,
    counted: true,
    requests: 1,
    ...(embedding ? { operation: 'embedding' as const } : {}),
  }
}

const TIER_KEYS = ['openai.response.service_tier', 'gen_ai.openai.response.service_tier'] as const

function tierAttribute(attrs: Map<string, unknown>): { key: string; value: unknown } | null {
  for (const key of TIER_KEYS) {
    const value = attrs.get(key)
    if (value !== undefined && value !== null && value !== '') return { key, value }
  }
  return null
}

function safeIso(v: unknown): string | null {
  if (v === undefined || v === null || v === '' || v === '0' || v === 0) return null
  try {
    const s = typeof v === 'number' ? BigInt(Math.trunc(v)).toString() : String(v)
    return toUtcIso(s, 'ns')
  } catch {
    return null
  }
}

function hexId(v: unknown): string {
  return typeof v === 'string' ? v.toLowerCase() : ''
}

class OtelRun {
  private entries: Entry[] = []
  private parents = new Map<string, string | null>()
  private usageKeys = new Set<string>()
  private variant: VariantId

  constructor(variant: VariantId) {
    this.variant = variant
  }

  push(record: RawRecord): AdapterRow[] {
    if (record.kind === 'error') return [malformedRow(this.variant, record.message, record.raw)]
    if (record.kind !== 'json' || !isObj(record.value)) {
      return [malformedRow(this.variant, 'expected an OTLP JSON object', record.kind === 'csv' ? record.row : '')]
    }
    const v = record.value
    if (Array.isArray(v.resourceSpans)) {
      for (const rs of v.resourceSpans) this.resourceSpans(rs)
      return []
    }
    if (Array.isArray(v.scopeSpans) || Array.isArray(v.instrumentationLibrarySpans)) {
      this.resourceSpans(v)
      return []
    }
    return [malformedRow(this.variant, 'no resourceSpans or scopeSpans', shortJson(v))]
  }

  private resourceSpans(rs: unknown): void {
    if (!isObj(rs)) {
      this.entries.push({ kind: 'malformed', row: malformedRow(this.variant, 'resourceSpans element is not an object', shortJson(rs)) })
      return
    }
    const resource = attributes(isObj(rs.resource) ? rs.resource.attributes : undefined)
    const service = str(resource.get('service.name'))
    const scopes = Array.isArray(rs.scopeSpans) ? rs.scopeSpans : Array.isArray(rs.instrumentationLibrarySpans) ? rs.instrumentationLibrarySpans : []
    for (const ss of scopes) {
      if (!isObj(ss) || !Array.isArray(ss.spans)) continue
      for (const span of ss.spans) this.span(span, service)
    }
  }

  private span(span: unknown, service: string | null): void {
    if (!isObj(span)) {
      this.entries.push({ kind: 'malformed', row: malformedRow(this.variant, 'span is not an object', shortJson(span)) })
      return
    }
    const traceId = hexId(span.traceId)
    const spanId = hexId(span.spanId)
    const parentId = hexId(span.parentSpanId)
    const key = `${traceId}/${spanId}`
    const parentKey = parentId ? `${traceId}/${parentId}` : null
    if (spanId) this.parents.set(key, parentKey)

    const attrs = attributes(span.attributes)
    const raw: Record<string, unknown> = {}
    const bad: string[] = []
    const usage = readUsage(attrs, raw, bad)
    if (!usage && bad.length === 0) return

    raw.traceId = traceId
    raw.spanId = spanId
    if (parentId) raw.parentSpanId = parentId
    if (typeof span.name === 'string') raw.name = span.name
    if (span.startTimeUnixNano !== undefined) raw.startTimeUnixNano = span.startTimeUnixNano
    if (service) raw['resource.service.name'] = service
    for (const k of TEXT_KEYS) if (attrs.has(k)) raw[k] = attrs.get(k)

    const duplicate = spanId !== '' && this.usageKeys.has(key)
    if (spanId) this.usageKeys.add(key)
    this.entries.push({
      kind: 'span',
      span: {
        key: spanId && !duplicate ? key : `${key}#${this.entries.length}`,
        duplicate,
        parentKey,
        usage,
        bad,
        op: str(attrs.get('gen_ai.operation.name')),
        provider: str(attrs.get('gen_ai.provider.name')) ?? str(attrs.get('gen_ai.system')),
        model: str(attrs.get('gen_ai.response.model')) ?? str(attrs.get('gen_ai.request.model')),
        start: span.startTimeUnixNano,
        tier: tierAttribute(attrs),
        raw,
      },
    })
  }

  finish(): AdapterRow[] {
    const rows = new Map<string, AdapterRow>()
    const spans: SpanEntry[] = []
    for (const e of this.entries) {
      if (e.kind !== 'span') continue
      const s = e.span
      if (s.bad.length > 0 || !s.usage) continue
      spans.push(s)
      rows.set(s.key, spanRow(s, s.usage, this.variant))
    }

    // Class by operation name before the tree pass.
    const kind = new Map<string, 'inference' | 'unnamed' | 'fetch' | 'aggregate'>()
    for (const s of spans) {
      const k = s.op === null ? 'unnamed' : INFERENCE_OPS.has(s.op) ? 'inference' : s.op === 'fetch_response' ? 'fetch' : 'aggregate'
      kind.set(s.key, k)
    }

    // Spans with usage that count toward totals, indexed by each ancestor.
    const countedBelow = new Map<string, SpanEntry[]>()
    for (const s of spans) {
      const k = kind.get(s.key)
      if (k === 'aggregate' || s.duplicate) continue
      const seen = new Set<string>([s.key])
      let p = this.parents.get(s.key) ?? s.parentKey
      while (p && !seen.has(p)) {
        seen.add(p)
        const list = countedBelow.get(p)
        if (list) list.push(s)
        else countedBelow.set(p, [s])
        p = this.parents.get(p) ?? null
      }
    }

    for (const s of spans) {
      const row = rows.get(s.key)
      const k = kind.get(s.key)
      if (!row || !k) continue
      const below = countedBelow.get(s.key) ?? []
      if (s.duplicate) {
        row.unresolvedReason = 'repeats an earlier span with the same traceId and spanId; review needed'
        row.mapping.push('duplicate span: left unresolved so it is not counted twice')
        if (k === 'aggregate') {
          row.counted = false
          row.flags.push('aggregate_span')
        }
      } else if (k === 'inference') {
        row.mapping.push(`counted: gen_ai.operation.name "${s.op}" is a model call`)
      } else if (k === 'fetch') {
        row.unresolvedReason ??= 'fetch_response spans should not report usage; review needed'
        row.mapping.push('fetch_response span with usage: left unresolved')
      } else if (k === 'unnamed') {
        if (below.length > 0) {
          row.flags.push('overlaps_counted_child')
          row.unresolvedReason ??= 'overlaps a counted child span; review needed'
          row.mapping.push(`counted: no gen_ai.operation.name, but ${below.length} counted descendant span(s) also report usage`)
        } else {
          row.mapping.push('counted: no gen_ai.operation.name and no counted descendant span reports usage')
        }
      } else {
        row.counted = false
        row.flags.push('aggregate_span')
        // fetch_response spans are left Unresolved (they should not report usage), so they are not
        // part of what the aggregate is checked against.
        const fetches = below.filter((d) => kind.get(d.key) === 'fetch')
        const parts = below.filter((d) => kind.get(d.key) !== 'fetch' && (kind.get(d.key) !== 'unnamed' || !(countedBelow.get(d.key)?.length)))
        const sumIn = parts.reduce((a, d) => a + (d.usage?.input ?? 0), 0)
        const sumOut = parts.reduce((a, d) => a + (d.usage?.output ?? 0), 0)
        const ownIn = s.usage?.input ?? 0
        const ownOut = s.usage?.output ?? 0
        const match = ownIn === sumIn && ownOut === sumOut
        if (!match) row.flags.push('aggregate_mismatch')
        row.mapping.push(
          `not counted: "${s.op}" span usage aggregates its children. Own input ${ownIn}, output ${ownOut}; ` +
            `sum of ${parts.length} counted descendant span(s): input ${sumIn}, output ${sumOut}` +
            (match ? ' (match)' : ' (mismatch)') +
            (fetches.length > 0 ? `; ${fetches.length} fetch_response span(s) with usage left out of the sum` : ''),
        )
      }
    }

    const out: AdapterRow[] = []
    for (const e of this.entries) {
      if (e.kind === 'malformed') {
        out.push(e.row)
        continue
      }
      const s = e.span
      if (s.bad.length > 0) {
        out.push(malformedRow(this.variant, `${s.bad.join(', ')} is not a non-negative integer`, shortJson(s.raw)))
        continue
      }
      const row = rows.get(s.key)
      if (row) out.push(row)
    }
    this.entries = []
    this.parents.clear()
    this.usageKeys.clear()
    return out
  }
}

function shortJson(v: unknown): string {
  try {
    return (JSON.stringify(v) ?? String(v)).slice(0, 2000)
  } catch {
    return String(v)
  }
}

function scoreOtlp(sample: RawRecord): { score: number; reason: string } {
  if (sample.kind !== 'json' || !isObj(sample.value)) return { score: 0, reason: 'not a JSON object' }
  const v = sample.value
  const resourceSpans = Array.isArray(v.resourceSpans) ? v.resourceSpans : Array.isArray(v.scopeSpans) ? [v] : null
  if (!resourceSpans) return { score: 0, reason: 'no resourceSpans or scopeSpans' }
  let genAi = false
  for (const rs of resourceSpans.slice(0, 20)) {
    if (!isObj(rs) || !Array.isArray(rs.scopeSpans)) continue
    for (const ss of rs.scopeSpans) {
      if (!isObj(ss) || !Array.isArray(ss.spans)) continue
      for (const span of ss.spans.slice(0, 200)) {
        if (isObj(span) && Array.isArray(span.attributes)) {
          if (span.attributes.some((a) => isObj(a) && typeof a.key === 'string' && a.key.startsWith('gen_ai.'))) genAi = true
        }
      }
    }
  }
  return genAi
    ? { score: 0.95, reason: 'OTLP JSON spans with gen_ai attributes' }
    : { score: 0.6, reason: 'OTLP JSON spans, but no gen_ai attributes in the first spans' }
}

export const otelAdapter: Adapter = {
  source: 'G',
  id: 'otel-genai-spans',
  version: '1.1.0',
  variants: ['G-otlp', 'G-otlp-jsonl'],
  label: 'OpenTelemetry GenAI spans',
  score: scoreOtlp,
  begin(ctx) {
    const run = new OtelRun(ctx.variant)
    return { push: (r) => run.push(r), finish: () => run.finish() }
  },
}
