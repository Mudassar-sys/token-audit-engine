import type { CacheDuration, Flag, Tier, TokenClasses, VariantId } from '../contracts'
import { ZERO_CACHE_WRITE, at, malformedRow, tok, toUtcIso } from './types'
import type { Adapter, AdapterRow, RawRecord } from './types'

/**
 * Source A: OpenAI Chat Completions response objects (JSON array or JSONL).
 * Also holds the small helpers shared by the other OpenAI-shaped adapters (B, C, E).
 */

/** Reads fields from one source object. Scalar values read land in raw; invalid token counts are remembered. */
export class FieldReader {
  readonly raw: Record<string, unknown> = {}
  readonly invalid: string[] = []
  private readonly root: unknown
  private readonly prefix: string

  constructor(root: unknown, prefix = '') {
    this.root = root
    this.prefix = prefix
  }

  get(path: string): unknown {
    const v = at(this.root, path)
    if (v !== undefined && (v === null || typeof v !== 'object')) this.raw[this.prefix + path] = v
    return v
  }

  /** Token count at path: null when absent, remembered as invalid when not a non-negative integer. */
  tokens(path: string): number | null {
    const n = tok(this.get(path))
    if (n !== null && Number.isNaN(n)) {
      this.invalid.push(this.prefix + path)
      return null
    }
    return n
  }

  text(path: string): string | null {
    const v = this.get(path)
    return typeof v === 'string' && v.trim() !== '' ? v : null
  }
}

/** Token class names as used in notMeasured and labels. */
export const TOKEN_CLASSES = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const
export type TokenClass = (typeof TOKEN_CLASSES)[number]

/** Collects flags, mapping lines, Not measured classes and Unresolved reasons for one row. */
export class RowNotes {
  readonly flags: Flag[] = []
  readonly reasons: string[] = []
  readonly mapping: string[] = []
  readonly notMeasured: string[] = []

  flag(f: Flag): void {
    if (!this.flags.includes(f)) this.flags.push(f)
  }

  /** The row cannot be costed without review. */
  unresolved(reason: string, f?: Flag): void {
    if (f) this.flag(f)
    if (!this.reasons.includes(reason)) this.reasons.push(reason)
  }

  /** Mark a token class absent in the source. The list stays in canonical class order. */
  missing(tokenClass: TokenClass, line: string): void {
    if (!this.notMeasured.includes(tokenClass)) {
      this.notMeasured.push(tokenClass)
      this.notMeasured.sort((a, b) => TOKEN_CLASSES.indexOf(a as TokenClass) - TOKEN_CLASSES.indexOf(b as TokenClass))
    }
    this.mapping.push(line)
  }

  reason(): string | null {
    return this.reasons.length > 0 ? this.reasons.join('; ') : null
  }
}

/** A source field and the value read from it (null when absent). */
export interface Term {
  field: string
  value: number | null
}

/** total minus every present part, with a mapping text that shows the numbers. */
export function difference(total: Term, parts: Term[]): { value: number; text: string } {
  const used = parts.filter((p) => p.value !== null)
  const value = (total.value ?? 0) - used.reduce((s, p) => s + (p.value ?? 0), 0)
  const text = [total, ...used].map((t) => `${t.field} (${t.value})`).join(' - ')
  return { value, text: used.length > 0 ? `${text} = ${value}` : text }
}

/** Keep only positive excluded counts. */
export function excludedOf(entries: [string, number | null][]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of entries) if (v !== null && v > 0) out[k] = (out[k] ?? 0) + v
  return out
}

const TIER_WORDS: Record<string, Tier> = {
  default: 'standard',
  standard: 'standard',
  flex: 'flex',
  priority: 'priority',
  // Fast mode is the renamed priority processing; responses normally report 'priority'.
  fast: 'priority',
  ultrafast: 'ultrafast',
}

/**
 * Map an OpenAI service_tier value from a response. auto or absent => null (standard assumed downstream).
 * scale => null, kept in raw; pricing marks it Not priced. Unknown values => Unresolved.
 */
export function readServiceTier(value: unknown, field: string, allowed: readonly Tier[], notes: RowNotes): Tier | null {
  if (value === null || value === undefined || value === '' || value === 'auto') {
    notes.mapping.push(`tier = not stated (${field} ${value === undefined ? 'absent' : JSON.stringify(value)})`)
    return null
  }
  if (value === 'scale') {
    notes.mapping.push(`tier = scale (${field}); the snapshot has no scale tier rate`)
    return null
  }
  const tier = typeof value === 'string' ? TIER_WORDS[value] : undefined
  if (tier && allowed.includes(tier)) {
    notes.mapping.push(`tier = ${tier} (${field} ${JSON.stringify(value)})`)
    return tier
  }
  notes.mapping.push(`tier = unknown (${field} ${JSON.stringify(value)})`)
  notes.unresolved(`unknown ${field} ${JSON.stringify(value)}; no documented tier mapping`)
  return null
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Malformed row for a record that is not usable JSON, or null when the record is a JSON value. */
export function rejectNonJson(record: RawRecord, variant: VariantId): AdapterRow | null {
  if (record.kind === 'error') return malformedRow(variant, record.message, record.raw)
  if (record.kind === 'csv') return malformedRow(variant, 'expected a JSON record, got a CSV row', record.row)
  return null
}

/** Malformed row naming the invalid token fields, keeping only the fields read. */
export function invalidRow(variant: VariantId, reader: FieldReader): AdapterRow {
  return malformedRow(variant, `${reader.invalid.join(', ')} not a non-negative integer`, reader.raw)
}

export interface ChatUsageOptions {
  provider: string | null
  /** Where unsplit cache writes go, with the reason shown in the mapping line. */
  writeDuration: CacheDuration
  writeDurationNote: string
  /** Read service_tier from the response (OpenAI) or leave the tier unstated (gateways). */
  readTier: boolean
}

/**
 * Normalize one Chat Completions shaped response (OpenAI or an OpenAI-compatible gateway).
 * prompt_tokens_details and completion_tokens_details are breakdowns of their totals, never additions.
 */
export function normalizeChatCompletion(
  value: unknown,
  variant: VariantId,
  optionsFor: (model: string | null) => ChatUsageOptions,
): { row: AdapterRow; reader: FieldReader; notes: RowNotes } | { malformed: AdapterRow } {
  if (!isObject(value)) return { malformed: malformedRow(variant, 'record is not a JSON object', value) }
  const r = new FieldReader(value)
  r.get('id')
  r.get('object')
  const model = r.text('model')
  const created = r.get('created')
  const tierValue = r.get('service_tier')
  if (!isObject(value.usage)) return { malformed: malformedRow(variant, 'no usage object', r.raw) }

  const prompt = r.tokens('usage.prompt_tokens')
  const cached = r.tokens('usage.prompt_tokens_details.cached_tokens')
  const write = r.tokens('usage.prompt_tokens_details.cache_write_tokens')
  const inAudio = r.tokens('usage.prompt_tokens_details.audio_tokens')
  const inImage = r.tokens('usage.prompt_tokens_details.image_tokens')
  const inVideo = r.tokens('usage.prompt_tokens_details.video_tokens')
  r.tokens('usage.prompt_tokens_details.text_tokens')
  const completion = r.tokens('usage.completion_tokens')
  const reasoning = r.tokens('usage.completion_tokens_details.reasoning_tokens')
  const outAudio = r.tokens('usage.completion_tokens_details.audio_tokens')
  const outImage = r.tokens('usage.completion_tokens_details.image_tokens')
  r.tokens('usage.completion_tokens_details.text_tokens')
  r.tokens('usage.completion_tokens_details.accepted_prediction_tokens')
  r.tokens('usage.completion_tokens_details.rejected_prediction_tokens')
  r.tokens('usage.total_tokens')
  if (r.invalid.length > 0) return { malformed: invalidRow(variant, r) }
  if (prompt === null && completion === null) {
    return { malformed: malformedRow(variant, 'usage has neither prompt_tokens nor completion_tokens', r.raw) }
  }

  const opts = optionsFor(model)
  const notes = new RowNotes()
  const cacheWrite: TokenClasses['cacheWrite'] = { ...ZERO_CACHE_WRITE }

  let uncachedInput = 0
  if (prompt === null) {
    notes.missing('uncachedInput', 'uncachedInput = not measured (usage.prompt_tokens absent)')
  } else {
    const d = difference({ field: 'usage.prompt_tokens', value: prompt }, [
      { field: 'prompt_tokens_details.cached_tokens', value: cached },
      { field: 'prompt_tokens_details.cache_write_tokens', value: write },
      { field: 'prompt_tokens_details.audio_tokens', value: inAudio },
      { field: 'prompt_tokens_details.image_tokens', value: inImage },
      { field: 'prompt_tokens_details.video_tokens', value: inVideo },
    ])
    notes.mapping.push(`uncachedInput = ${d.text}`)
    if (d.value < 0) notes.unresolved('cache and modality tokens exceed usage.prompt_tokens', 'cache_exceeds_input')
    else uncachedInput = d.value
  }

  if (cached === null) notes.missing('cacheRead', 'cacheRead = not measured (usage.prompt_tokens_details.cached_tokens absent)')
  else notes.mapping.push(`cacheRead = usage.prompt_tokens_details.cached_tokens (${cached})`)

  if (write === null) {
    notes.missing('cacheWrite', 'cacheWrite = not measured (usage.prompt_tokens_details.cache_write_tokens absent)')
  } else if (write > 0) {
    cacheWrite[opts.writeDuration] = write
    notes.flag('duration_assumed')
    notes.mapping.push(`cacheWrite.${opts.writeDuration} = usage.prompt_tokens_details.cache_write_tokens (${write}); ${opts.writeDurationNote}`)
  } else {
    notes.mapping.push('cacheWrite = usage.prompt_tokens_details.cache_write_tokens (0)')
  }

  let output = 0
  if (completion === null) {
    notes.missing('output', 'output = not measured (usage.completion_tokens absent)')
  } else {
    const d = difference({ field: 'usage.completion_tokens', value: completion }, [
      { field: 'completion_tokens_details.audio_tokens', value: outAudio },
      { field: 'completion_tokens_details.image_tokens', value: outImage },
    ])
    notes.mapping.push(`output = ${d.text}`)
    if (d.value < 0) notes.unresolved('audio and image output tokens exceed usage.completion_tokens', 'totals_disagree')
    else output = d.value
  }

  if (reasoning === null) {
    notes.missing('reasoning', 'reasoning = not measured (usage.completion_tokens_details.reasoning_tokens absent)')
  } else {
    notes.mapping.push(`reasoning = usage.completion_tokens_details.reasoning_tokens (${reasoning}), part of output, never added`)
    if (completion !== null && reasoning > output) notes.unresolved('reasoning tokens exceed text output tokens', 'totals_disagree')
  }

  const tierStated = opts.readTier ? readServiceTier(tierValue, 'service_tier', ['standard', 'flex', 'priority'], notes) : null
  if (!opts.readTier) notes.mapping.push('tier = not stated in the source')
  if (model === null) notes.flag('model_missing')
  notes.mapping.push(`model = ${model === null ? 'absent' : `model (${model})`}`)

  const row: AdapterRow = {
    timestamp: toUtcIso(created, 's'),
    variant,
    provider: opts.provider,
    modelLogged: model,
    tierStated,
    granularity: 'request',
    tokens: { uncachedInput, cacheRead: cached ?? 0, cacheWrite, output, reasoning },
    notMeasured: notes.notMeasured,
    excluded: excludedOf([
      ['input_audio', inAudio],
      ['input_image', inImage],
      ['input_video', inVideo],
      ['output_audio', outAudio],
      ['output_image', outImage],
    ]),
    reported: null,
    raw: r.raw,
    mapping: notes.mapping,
    flags: notes.flags,
    unresolvedReason: notes.reason(),
    counted: true,
    requests: 1,
  }
  return { row, reader: r, notes }
}

/** Hints that a chat completion came through a router: provider-prefixed model, gen- id, usage.cost. */
export function routingHints(v: Record<string, unknown>): string[] {
  const hints: string[] = []
  if (typeof v.model === 'string' && v.model.includes('/')) hints.push('provider-prefixed model id')
  if (typeof v.id === 'string' && v.id.startsWith('gen-')) hints.push('gen- id')
  if (isObject(v.usage) && v.usage.cost !== undefined) hints.push('usage.cost')
  return hints
}

/** True when the value carries Chat Completions usage counts. */
export function hasChatUsage(v: unknown): v is Record<string, unknown> & { usage: Record<string, unknown> } {
  return isObject(v) && isObject(v.usage) && (v.usage.prompt_tokens !== undefined || v.usage.completion_tokens !== undefined)
}

function scoreChat(sample: RawRecord): { score: number; reason: string } {
  if (sample.kind !== 'json') return { score: 0, reason: 'not a JSON record' }
  const v = sample.value
  if (!hasChatUsage(v)) return { score: 0, reason: 'no usage.prompt_tokens or usage.completion_tokens' }
  const hints = routingHints(v)
  const isChat = v.object === 'chat.completion' || v.object === 'chat.completion.chunk'
  if (hints.length > 0) return { score: isChat ? 0.5 : 0.4, reason: `chat completion usage, but ${hints.join(', ')} point to a router` }
  if (isChat) return { score: 0.95, reason: `object ${String(v.object)} with usage.prompt_tokens` }
  return { score: 0.7, reason: 'usage.prompt_tokens and completion_tokens without an object field' }
}

const CHAT_OPTIONS: ChatUsageOptions = {
  provider: 'openai',
  writeDuration: '30m',
  writeDurationNote: 'Chat Completions has no TTL breakdown and accepts only ttl 30m',
  readTier: true,
}

export const openaiChatAdapter: Adapter = {
  source: 'A',
  id: 'openai-chat-completions',
  version: '1.0.0',
  variants: ['A-json', 'A-jsonl'],
  label: 'OpenAI Chat Completions responses',
  score: scoreChat,
  begin(ctx) {
    return {
      push(record) {
        const bad = rejectNonJson(record, ctx.variant)
        if (bad) return [bad]
        const out = normalizeChatCompletion(record.kind === 'json' ? record.value : null, ctx.variant, () => CHAT_OPTIONS)
        return ['malformed' in out ? out.malformed : out.row]
      },
      finish: () => [],
    }
  },
}
