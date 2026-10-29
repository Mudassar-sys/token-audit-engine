import type { Tier, TokenClasses, VariantId } from '../contracts'
import { ZERO_CACHE_WRITE, malformedRow, toUtcIso } from './types'
import type { Adapter, AdapterRow, RawRecord } from './types'
import { FieldReader, RowNotes, excludedOf, isObject, readServiceTier, rejectNonJson } from './openaiChat'

/**
 * Source C: OpenAI organization Usage API, completions page. One record is one time bucket
 * ($.data.*); each result in the bucket becomes one time_bucket row.
 *
 * Totals and breakdowns (all optional except input_tokens, output_tokens, num_model_requests):
 *   input_tokens = input_cached_tokens + input_cache_write_tokens + input_uncached_tokens
 *   input_cached_tokens = input_cached_text_tokens + input_cached_audio_tokens + input_cached_image_tokens
 *   input_cache_write_tokens = input_cache_write_30m_tokens + input_cache_write_12h_tokens
 *   input_uncached_tokens = input_text_tokens + input_audio_tokens + input_image_tokens
 *   output_tokens = output_text_tokens + output_audio_tokens + output_image_tokens
 * A total is never subtracted together with its own breakdown.
 */

export const USAGE_RESULT_OBJECT = 'organization.usage.completions.result'

const sum = (vals: (number | null)[]) => vals.reduce<number>((s, v) => s + (v ?? 0), 0)
const complete = (vals: (number | null)[]) => vals.every((v) => v !== null)

export function normalizeUsageResult(result: unknown, bucket: Record<string, unknown> | null, variant: VariantId): AdapterRow {
  const b = new FieldReader(bucket ?? {}, 'bucket.')
  const start = b.get('start_time')
  b.get('end_time')
  if (!isObject(result)) return malformedRow(variant, 'usage result is not a JSON object', { ...b.raw, result })
  const r = new FieldReader(result, 'result.')
  const object = r.get('object')
  if (object !== undefined && object !== USAGE_RESULT_OBJECT) {
    return malformedRow(variant, `result object ${JSON.stringify(object)} is not a completions usage result`, { ...b.raw, ...r.raw })
  }

  const input = r.tokens('input_tokens')
  const cachedTotal = r.tokens('input_cached_tokens')
  const cachedAudio = r.tokens('input_cached_audio_tokens')
  const cachedImage = r.tokens('input_cached_image_tokens')
  const cachedParts = [r.tokens('input_cached_text_tokens'), cachedAudio, cachedImage]
  const writeTotalField = r.tokens('input_cache_write_tokens')
  const w30 = r.tokens('input_cache_write_30m_tokens')
  const w12 = r.tokens('input_cache_write_12h_tokens')
  const uncachedTotal = r.tokens('input_uncached_tokens')
  const uncachedAudio = r.tokens('input_audio_tokens')
  const uncachedImage = r.tokens('input_image_tokens')
  const uncachedParts = [r.tokens('input_text_tokens'), uncachedAudio, uncachedImage]
  const outputTotal = r.tokens('output_tokens')
  const outAudio = r.tokens('output_audio_tokens')
  const outImage = r.tokens('output_image_tokens')
  const outputParts = [r.tokens('output_text_tokens'), outAudio, outImage]
  const requests = r.tokens('num_model_requests')
  const model = r.text('model')
  for (const f of ['project_id', 'user_id', 'api_key_id', 'api_source']) r.get(f)
  const batch = r.get('batch')
  const tierValue = r.get('service_tier')
  const raw = { ...b.raw, ...r.raw }
  if (r.invalid.length > 0) return malformedRow(variant, `${r.invalid.join(', ')} not a non-negative integer`, raw)
  if (input === null && outputTotal === null) return malformedRow(variant, 'result has neither input_tokens nor output_tokens', raw)

  const notes = new RowNotes()
  const cacheWrite: TokenClasses['cacheWrite'] = { ...ZERO_CACHE_WRITE }

  // Cache read total: the total field, else the complete modality breakdown, else not measured.
  let readTotal: number | null = null
  if (cachedTotal !== null) {
    readTotal = cachedTotal
    const s = sum(cachedParts)
    if ((complete(cachedParts) && s !== cachedTotal) || s > cachedTotal) {
      notes.unresolved(`input_cached_text/audio/image_tokens sum (${s}) differs from input_cached_tokens (${cachedTotal})`, 'totals_disagree')
    }
  } else if (complete(cachedParts)) {
    readTotal = sum(cachedParts)
  }

  // Cache write total: the total field, else the complete TTL breakdown, else not measured.
  let writeTotal: number | null = null
  if (writeTotalField !== null) {
    writeTotal = writeTotalField
    if (w30 !== null && w12 !== null) {
      cacheWrite['30m'] = w30
      cacheWrite['12h'] = w12
      notes.mapping.push(`cacheWrite.30m = result.input_cache_write_30m_tokens (${w30}); cacheWrite.12h = result.input_cache_write_12h_tokens (${w12})`)
      if (w30 + w12 !== writeTotalField) {
        notes.unresolved(`input_cache_write_30m/12h_tokens sum (${w30 + w12}) differs from input_cache_write_tokens (${writeTotalField})`, 'totals_disagree')
      }
    } else if (w30 !== null && w30 === writeTotalField) {
      cacheWrite['30m'] = w30
      notes.mapping.push(`cacheWrite.30m = result.input_cache_write_30m_tokens (${w30}), equal to input_cache_write_tokens`)
    } else if (w12 !== null && w12 === writeTotalField) {
      cacheWrite['12h'] = w12
      notes.mapping.push(`cacheWrite.12h = result.input_cache_write_12h_tokens (${w12}), equal to input_cache_write_tokens`)
    } else if (w30 === null && w12 !== null && w12 < writeTotalField) {
      // The 30m part may be null on older data; total = 30m + 12h, so it follows from the other two.
      cacheWrite['12h'] = w12
      cacheWrite['30m'] = writeTotalField - w12
      notes.mapping.push(
        `cacheWrite.12h = result.input_cache_write_12h_tokens (${w12}); cacheWrite.30m = result.input_cache_write_tokens (${writeTotalField}) - input_cache_write_12h_tokens (${w12}) = ${writeTotalField - w12}, derived because input_cache_write_30m_tokens is ${result.input_cache_write_30m_tokens === null ? 'null' : 'absent'}`,
      )
    } else if (w12 === null && w30 !== null && w30 < writeTotalField) {
      cacheWrite['30m'] = w30
      cacheWrite['12h'] = writeTotalField - w30
      notes.mapping.push(
        `cacheWrite.30m = result.input_cache_write_30m_tokens (${w30}); cacheWrite.12h = result.input_cache_write_tokens (${writeTotalField}) - input_cache_write_30m_tokens (${w30}) = ${writeTotalField - w30}, derived because input_cache_write_12h_tokens is ${result.input_cache_write_12h_tokens === null ? 'null' : 'absent'}`,
      )
    } else {
      if (sum([w30, w12]) > writeTotalField) {
        notes.unresolved(`input_cache_write_30m/12h_tokens (${sum([w30, w12])}) exceed input_cache_write_tokens (${writeTotalField})`, 'totals_disagree')
      }
      if (writeTotalField > 0) {
        cacheWrite['30m'] = writeTotalField
        notes.flag('duration_assumed')
        notes.mapping.push(`cacheWrite.30m = result.input_cache_write_tokens (${writeTotalField}); no complete TTL breakdown, 30m assumed`)
      } else {
        notes.mapping.push('cacheWrite = result.input_cache_write_tokens (0)')
      }
    }
  } else if (w30 !== null && w12 !== null) {
    writeTotal = w30 + w12
    cacheWrite['30m'] = w30
    cacheWrite['12h'] = w12
    notes.mapping.push(`cacheWrite.30m = result.input_cache_write_30m_tokens (${w30}); cacheWrite.12h = result.input_cache_write_12h_tokens (${w12}); no total field`)
  } else {
    notes.missing('cacheWrite', 'cacheWrite = not measured (input_cache_write_tokens absent and the 30m/12h breakdown incomplete)')
  }

  // Cache read total from the documented identity input = cached + write + uncached, when the
  // cached total and its full breakdown are both missing but the other three totals are stated.
  let readDerived = false
  if (readTotal === null && input !== null && writeTotal !== null && uncachedTotal !== null) {
    const derived = input - writeTotal - uncachedTotal
    if (derived >= 0) {
      readTotal = derived
      readDerived = true
      if (sum(cachedParts) > derived) {
        notes.unresolved(`input_cached_text/audio/image_tokens (${sum(cachedParts)}) exceed the derived cache read total (${derived})`, 'totals_disagree')
      }
    }
  }

  // Uncached input: total minus cache read total minus cache write total, never minus a breakdown.
  let uncachedInput = 0
  if (input === null) {
    notes.missing('uncachedInput', 'uncachedInput = not measured (result.input_tokens absent)')
  } else {
    const uncachedAll = input - (readTotal ?? 0) - (writeTotal ?? 0)
    if (uncachedAll < 0) {
      notes.unresolved('cache read and cache write totals exceed result.input_tokens', 'cache_exceeds_input')
    } else if (uncachedTotal !== null && uncachedTotal !== uncachedAll) {
      // Checked even when a cache total is not measured: a missing total then counts as 0 here.
      notes.unresolved(`input_uncached_tokens (${uncachedTotal}) differs from input_tokens - cache read total - cache write total (${uncachedAll})`, 'totals_disagree')
    }
    if (uncachedTotal !== null && complete(uncachedParts) && sum(uncachedParts) !== uncachedTotal) {
      notes.unresolved(`input_text/audio/image_tokens sum (${sum(uncachedParts)}) differs from input_uncached_tokens (${uncachedTotal})`, 'totals_disagree')
    }
    // Audio and image tokens are excluded from token cost. Cached audio/image sit inside the cache
    // read total when it is measured, otherwise inside the uncached remainder.
    const modal = sum([uncachedAudio, uncachedImage]) + (readTotal === null ? sum([cachedAudio, cachedImage]) : 0)
    const text = uncachedAll - modal
    const terms = [`result.input_tokens (${input})`]
    if (readTotal !== null) terms.push(`cache read total (${readTotal})`)
    if (writeTotal !== null) terms.push(`cache write total (${writeTotal})`)
    if (modal > 0) terms.push(`audio and image input (${modal})`)
    notes.mapping.push(`uncachedInput = ${terms.join(' - ')} = ${text}`)
    if (uncachedAll >= 0 && text < 0) notes.unresolved('audio and image input tokens exceed the uncached input', 'totals_disagree')
    if (uncachedAll >= 0 && text >= 0) uncachedInput = text
  }

  let cacheRead = 0
  if (readTotal === null) {
    notes.missing('cacheRead', 'cacheRead = not measured (input_cached_tokens absent and the modality breakdown incomplete)')
  } else {
    const text = readTotal - sum([cachedAudio, cachedImage])
    const src = cachedTotal !== null
      ? `result.input_cached_tokens (${readTotal})`
      : readDerived
        ? `cache read total derived as result.input_tokens (${input}) - input_cache_write total (${writeTotal}) - input_uncached_tokens (${uncachedTotal}) = ${readTotal}, input_cached_tokens absent`
        : `sum of input_cached_text/audio/image_tokens (${readTotal})`
    notes.mapping.push(sum([cachedAudio, cachedImage]) > 0 ? `cacheRead = ${src} - cached audio and image (${sum([cachedAudio, cachedImage])}) = ${text}` : `cacheRead = ${src}`)
    if (text < 0) notes.unresolved('cached audio and image tokens exceed the cache read total', 'totals_disagree')
    else cacheRead = text
  }

  let output = 0
  if (outputTotal === null) {
    notes.missing('output', 'output = not measured (result.output_tokens absent)')
  } else {
    const text = outputTotal - sum([outAudio, outImage])
    notes.mapping.push(sum([outAudio, outImage]) > 0 ? `output = result.output_tokens (${outputTotal}) - audio and image output (${sum([outAudio, outImage])}) = ${text}` : `output = result.output_tokens (${outputTotal})`)
    if (complete(outputParts) && sum(outputParts) !== outputTotal) {
      notes.unresolved(`output_text/audio/image_tokens sum (${sum(outputParts)}) differs from output_tokens (${outputTotal})`, 'totals_disagree')
    }
    if (text < 0) notes.unresolved('audio and image output tokens exceed result.output_tokens', 'totals_disagree')
    else output = text
  }
  notes.missing('reasoning', 'reasoning = not measured (the Usage API has no reasoning field)')

  let tierStated: Tier | null
  if (batch === true) {
    tierStated = 'batch'
    notes.mapping.push('tier = batch (result.batch true)')
  } else {
    tierStated = readServiceTier(tierValue, 'result.service_tier', ['standard', 'flex', 'priority', 'ultrafast'], notes)
  }
  if (model === null) notes.flag('model_missing')
  notes.mapping.push(`model = ${model === null ? 'absent (result.model null; group by model to fill it)' : `result.model (${model})`}`)
  notes.mapping.push(requests === null ? 'requests = 0 (result.num_model_requests absent)' : `requests = result.num_model_requests (${requests})`)

  return {
    timestamp: toUtcIso(start, 's'),
    variant,
    provider: 'openai',
    modelLogged: model,
    tierStated,
    granularity: 'time_bucket',
    tokens: { uncachedInput, cacheRead, cacheWrite, output, reasoning: null },
    notMeasured: notes.notMeasured,
    excluded: excludedOf([
      ['input_audio', sum([uncachedAudio, cachedAudio])],
      ['input_image', sum([uncachedImage, cachedImage])],
      ['output_audio', outAudio],
      ['output_image', outImage],
    ]),
    reported: null,
    raw,
    mapping: notes.mapping,
    flags: notes.flags,
    unresolvedReason: notes.reason(),
    counted: true,
    requests: requests ?? 0,
  }
}

/** Rows for one bucket. A whole page or a bare result is accepted too. */
export function normalizeUsageRecord(value: unknown, variant: VariantId): AdapterRow[] {
  if (!isObject(value)) return [malformedRow(variant, 'bucket is not a JSON object', value)]
  if (value.object === 'page' && Array.isArray(value.data)) return value.data.flatMap((bk) => normalizeUsageRecord(bk, variant))
  if (value.object === USAGE_RESULT_OBJECT) return [normalizeUsageResult(value, null, variant)]
  if (!Array.isArray(value.results)) {
    const b = new FieldReader(value, 'bucket.')
    b.get('object')
    b.get('start_time')
    b.get('end_time')
    return [malformedRow(variant, 'bucket has no results array', b.raw)]
  }
  return value.results.map((res) => normalizeUsageResult(res, value, variant))
}

function firstResult(v: Record<string, unknown>): unknown {
  if (v.object === 'page' && Array.isArray(v.data)) {
    const bk: unknown = v.data[0]
    return isObject(bk) && Array.isArray(bk.results) ? (bk.results[0] ?? null) : undefined
  }
  if (Array.isArray(v.results)) return v.results[0] ?? null
  return v
}

function scoreUsage(sample: RawRecord): { score: number; reason: string } {
  if (sample.kind !== 'json' || !isObject(sample.value)) return { score: 0, reason: 'not a JSON object' }
  const v = sample.value
  const res = firstResult(v)
  if (isObject(res) && res.object === USAGE_RESULT_OBJECT) return { score: 0.98, reason: `${USAGE_RESULT_OBJECT} in a usage bucket` }
  // Other usage endpoints (embeddings, images, audio, ...) name their own result object and are not supported.
  if (isObject(res) && res.object !== undefined) return { score: 0, reason: `result object ${JSON.stringify(res.object)} is not a completions usage result` }
  if (res === null && (v.object === 'bucket' || v.object === 'page')) return { score: 0.8, reason: `usage ${String(v.object)} with no results yet` }
  if (isObject(res) && res.num_model_requests !== undefined && res.input_tokens !== undefined) {
    return { score: 0.6, reason: 'num_model_requests and input_tokens without the result object name' }
  }
  return { score: 0, reason: 'no completions usage result' }
}

export const openaiUsageAdapter: Adapter = {
  source: 'C',
  id: 'openai-usage-completions',
  version: '1.0.0',
  variants: ['C-page'],
  label: 'OpenAI organization Usage API, completions page',
  score: scoreUsage,
  begin(ctx) {
    return {
      push(record) {
        const bad = rejectNonJson(record, ctx.variant)
        if (bad) return [bad]
        return normalizeUsageRecord(record.kind === 'json' ? record.value : null, ctx.variant)
      },
      finish: () => [],
    }
  },
}
