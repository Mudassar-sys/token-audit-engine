import type { TokenClasses, VariantId } from '../contracts'
import { ZERO_CACHE_WRITE, malformedRow, toUtcIso } from './types'
import type { Adapter, AdapterRow, RawRecord } from './types'
import { FieldReader, RowNotes, difference, invalidRow, isObject, readServiceTier, rejectNonJson } from './openaiChat'

/**
 * Source B: OpenAI Responses API response objects (JSON array or JSONL).
 * input_tokens includes cached reads and cache writes; output_tokens includes reasoning.
 */

const DETAILS = 'usage.input_tokens_details'

export function normalizeResponse(value: unknown, variant: VariantId): AdapterRow {
  if (!isObject(value)) return malformedRow(variant, 'record is not a JSON object', value)
  const r = new FieldReader(value)
  r.get('id')
  r.get('object')
  r.get('status')
  const model = r.text('model')
  const created = r.get('created_at')
  const tierValue = r.get('service_tier')
  if (!isObject(value.usage)) return malformedRow(variant, 'no usage object', r.raw)

  const input = r.tokens('usage.input_tokens')
  const cached = r.tokens(`${DETAILS}.cached_tokens`)
  const write = r.tokens(`${DETAILS}.cache_write_tokens`)
  const ttl30 = r.tokens(`${DETAILS}.cache_write_tokens_details.ttl_30m_tokens`)
  const ttl12 = r.tokens(`${DETAILS}.cache_write_tokens_details.ttl_12h_tokens`)
  const outputTokens = r.tokens('usage.output_tokens')
  const reasoning = r.tokens('usage.output_tokens_details.reasoning_tokens')
  r.tokens('usage.total_tokens')
  if (r.invalid.length > 0) return invalidRow(variant, r)
  if (input === null && outputTokens === null) {
    return malformedRow(variant, 'usage has neither input_tokens nor output_tokens', r.raw)
  }

  const notes = new RowNotes()
  const cacheWrite: TokenClasses['cacheWrite'] = { ...ZERO_CACHE_WRITE }

  // Cache writes: split by the TTL detail when present, else all 30m (assumed).
  let writeTotal: number | null = write
  if (ttl30 !== null || ttl12 !== null) {
    const sum = (ttl30 ?? 0) + (ttl12 ?? 0)
    cacheWrite['30m'] = ttl30 ?? 0
    cacheWrite['12h'] = ttl12 ?? 0
    notes.mapping.push(`cacheWrite.30m = ${DETAILS}.cache_write_tokens_details.ttl_30m_tokens (${ttl30 ?? 'absent'})`)
    notes.mapping.push(`cacheWrite.12h = ${DETAILS}.cache_write_tokens_details.ttl_12h_tokens (${ttl12 ?? 'absent'})`)
    if (write === null) writeTotal = sum
    else if (sum !== write) {
      notes.unresolved(`cache write TTL breakdown (${sum}) differs from input_tokens_details.cache_write_tokens (${write})`, 'totals_disagree')
    }
  } else if (write === null) {
    notes.missing('cacheWrite', `cacheWrite = not measured (${DETAILS}.cache_write_tokens absent)`)
  } else if (write > 0) {
    cacheWrite['30m'] = write
    notes.flag('duration_assumed')
    notes.mapping.push(`cacheWrite.30m = ${DETAILS}.cache_write_tokens (${write}); no TTL breakdown in the row, 30m assumed`)
  } else {
    notes.mapping.push(`cacheWrite = ${DETAILS}.cache_write_tokens (0)`)
  }

  let uncachedInput = 0
  if (input === null) {
    notes.missing('uncachedInput', 'uncachedInput = not measured (usage.input_tokens absent)')
  } else {
    const d = difference({ field: 'usage.input_tokens', value: input }, [
      { field: 'input_tokens_details.cached_tokens', value: cached },
      { field: write === null && writeTotal !== null ? 'cache write TTL breakdown' : 'input_tokens_details.cache_write_tokens', value: writeTotal },
    ])
    notes.mapping.push(`uncachedInput = ${d.text}`)
    if (d.value < 0) notes.unresolved('cached and cache-write tokens exceed usage.input_tokens', 'cache_exceeds_input')
    else uncachedInput = d.value
  }

  if (cached === null) notes.missing('cacheRead', `cacheRead = not measured (${DETAILS}.cached_tokens absent)`)
  else notes.mapping.push(`cacheRead = ${DETAILS}.cached_tokens (${cached})`)

  if (outputTokens === null) notes.missing('output', 'output = not measured (usage.output_tokens absent)')
  else notes.mapping.push(`output = usage.output_tokens (${outputTokens})`)

  if (reasoning === null) {
    notes.missing('reasoning', 'reasoning = not measured (usage.output_tokens_details.reasoning_tokens absent)')
  } else {
    notes.mapping.push(`reasoning = usage.output_tokens_details.reasoning_tokens (${reasoning}), part of output, never added`)
    if (outputTokens !== null && reasoning > outputTokens) notes.unresolved('reasoning tokens exceed usage.output_tokens', 'totals_disagree')
  }

  const tierStated = readServiceTier(tierValue, 'service_tier', ['standard', 'flex', 'priority', 'ultrafast'], notes)
  if (model === null) notes.flag('model_missing')
  notes.mapping.push(`model = ${model === null ? 'absent' : `model (${model})`}`)

  return {
    timestamp: toUtcIso(created, 's'),
    variant,
    provider: 'openai',
    modelLogged: model,
    tierStated,
    granularity: 'request',
    tokens: { uncachedInput, cacheRead: cached ?? 0, cacheWrite, output: outputTokens ?? 0, reasoning },
    notMeasured: notes.notMeasured,
    excluded: {},
    reported: null,
    raw: r.raw,
    mapping: notes.mapping,
    flags: notes.flags,
    unresolvedReason: notes.reason(),
    counted: true,
    requests: 1,
  }
}

function scoreResponses(sample: RawRecord): { score: number; reason: string } {
  if (sample.kind !== 'json') return { score: 0, reason: 'not a JSON record' }
  const v = sample.value
  if (!isObject(v) || !isObject(v.usage)) return { score: 0, reason: 'no usage object' }
  const u = v.usage
  if (u.input_tokens === undefined && u.output_tokens === undefined) return { score: 0, reason: 'no usage.input_tokens or usage.output_tokens' }
  if (v.object === 'response') return { score: 0.95, reason: 'object response with usage.input_tokens' }
  if (v.type === 'message') return { score: 0.05, reason: 'type message points to another source' }
  if (isObject(u.input_tokens_details) || isObject(u.output_tokens_details)) {
    return { score: 0.75, reason: 'usage.input_tokens_details without an object field' }
  }
  return { score: 0.3, reason: 'usage.input_tokens without Responses API markers' }
}

export const openaiResponsesAdapter: Adapter = {
  source: 'B',
  id: 'openai-responses',
  version: '1.0.0',
  variants: ['B-json', 'B-jsonl'],
  label: 'OpenAI Responses API responses',
  score: scoreResponses,
  begin(ctx) {
    return {
      push(record) {
        const bad = rejectNonJson(record, ctx.variant)
        if (bad) return [bad]
        return [normalizeResponse(record.kind === 'json' ? record.value : null, ctx.variant)]
      },
      finish: () => [],
    }
  },
}
