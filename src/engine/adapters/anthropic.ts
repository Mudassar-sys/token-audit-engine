import type { Flag, Tier, VariantId, TokenClasses } from '../contracts'
import type { Adapter, AdapterRow, RawRecord } from './types'
import { ZERO_CACHE_WRITE, at, malformedRow, tok } from './types'

/**
 * Source D: Anthropic Messages API responses (`type: 'message'`).
 * usage.input_tokens already excludes cache reads and cache writes, so nothing is subtracted.
 */

const TIERS: Record<string, Tier> = { standard: 'standard', priority: 'priority', batch: 'batch' }

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function rawText(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/** Normalize one Messages API response object into a row. Never throws. */
export function normalizeAnthropicMessage(value: unknown, variant: VariantId): AdapterRow {
  if (!isObj(value)) return malformedRow(variant, 'record is not a JSON object', rawText(value))
  if (value.type !== undefined && value.type !== 'message') {
    return malformedRow(variant, `type is "${String(value.type)}", not "message"`, rawText(value))
  }
  if (!isObj(value.usage)) return malformedRow(variant, 'no usage object', rawText(value))

  const raw: Record<string, unknown> = {}
  const bad: string[] = []
  const keep = (path: string): unknown => {
    const v = at(value, path)
    if (v !== undefined) raw[path] = v
    return v
  }
  const read = (path: string): number | null => {
    const n = tok(keep(path))
    if (Number.isNaN(n)) {
      bad.push(path)
      return null
    }
    return n
  }

  keep('id')
  const model = keep('model')
  const input = read('usage.input_tokens')
  const cacheRead = read('usage.cache_read_input_tokens')
  const writeTotal = read('usage.cache_creation_input_tokens')
  const breakdown = isObj(value.usage.cache_creation)
  const w5 = breakdown ? read('usage.cache_creation.ephemeral_5m_input_tokens') : null
  const w1h = breakdown ? read('usage.cache_creation.ephemeral_1h_input_tokens') : null
  const output = read('usage.output_tokens')
  const reasoning = read('usage.output_tokens_details.thinking_tokens')
  const webSearch = read('usage.server_tool_use.web_search_requests')
  const webFetch = read('usage.server_tool_use.web_fetch_requests')
  const tierRaw = keep('usage.service_tier')
  keep('usage.speed')
  keep('usage.inference_geo')

  if (bad.length > 0) return malformedRow(variant, `${bad.join(', ')} is not a non-negative integer`, rawText(value))

  const flags: Flag[] = []
  const notMeasured: string[] = []
  const mapping: string[] = []
  let unresolvedReason: string | null = null
  const cacheWrite: TokenClasses['cacheWrite'] = { ...ZERO_CACHE_WRITE }

  if (input === null) {
    notMeasured.push('uncachedInput')
    mapping.push('uncachedInput = not measured (usage.input_tokens absent)')
  } else mapping.push('uncachedInput = usage.input_tokens (already excludes cache reads and cache writes)')

  if (cacheRead === null) notMeasured.push('cacheRead')
  else mapping.push('cacheRead = usage.cache_read_input_tokens')

  if (breakdown) {
    cacheWrite['5m'] = w5 ?? 0
    cacheWrite['1h'] = w1h ?? 0
    mapping.push(
      'cacheWrite.5m = usage.cache_creation.ephemeral_5m_input_tokens',
      'cacheWrite.1h = usage.cache_creation.ephemeral_1h_input_tokens',
    )
    const sum = cacheWrite['5m'] + cacheWrite['1h']
    if (writeTotal !== null && writeTotal !== sum) {
      flags.push('totals_disagree')
      unresolvedReason = `usage.cache_creation_input_tokens (${writeTotal}) differs from its 5m plus 1h breakdown (${sum})`
    }
  } else if (writeTotal !== null) {
    cacheWrite['5m'] = writeTotal
    mapping.push('cacheWrite.5m = usage.cache_creation_input_tokens (no duration breakdown, 5m assumed)')
    if (writeTotal > 0) flags.push('duration_assumed')
  } else {
    notMeasured.push('cacheWrite')
  }

  if (output === null) {
    notMeasured.push('output')
    mapping.push('output = not measured (usage.output_tokens absent)')
  } else mapping.push('output = usage.output_tokens (includes thinking tokens)')

  if (reasoning === null) notMeasured.push('reasoning')
  else {
    mapping.push('reasoning = usage.output_tokens_details.thinking_tokens (part of output, never added)')
    if (output !== null && reasoning > output) {
      flags.push('totals_disagree')
      unresolvedReason ??= `thinking tokens (${reasoning}) exceed output tokens (${output})`
    }
  }

  const excluded: Record<string, number> = {}
  if (webSearch !== null && webSearch > 0) {
    excluded.web_search_requests = webSearch
    mapping.push('excluded.web_search_requests = usage.server_tool_use.web_search_requests (not priced)')
  }
  if (webFetch !== null && webFetch > 0) {
    excluded.web_fetch_requests = webFetch
    mapping.push('excluded.web_fetch_requests = usage.server_tool_use.web_fetch_requests (not priced)')
  }

  let tierStated: Tier | null = null
  if (typeof tierRaw === 'string' && tierRaw !== '') {
    const t = TIERS[tierRaw]
    if (t) {
      tierStated = t
      mapping.push(`tier = usage.service_tier ("${tierRaw}")`)
    } else {
      unresolvedReason ??= `usage.service_tier "${tierRaw}" is not a known Messages API tier`
    }
  }

  const modelLogged = typeof model === 'string' && model !== '' ? model : null
  if (modelLogged === null) flags.push('model_missing')

  return {
    timestamp: null,
    variant,
    provider: 'anthropic',
    modelLogged,
    tierStated,
    granularity: 'request',
    tokens: {
      uncachedInput: input ?? 0,
      cacheRead: cacheRead ?? 0,
      cacheWrite,
      output: output ?? 0,
      reasoning,
    },
    notMeasured,
    excluded,
    reported: null,
    raw,
    mapping,
    flags,
    unresolvedReason,
    counted: true,
    requests: 1,
  }
}

function scoreMessage(sample: RawRecord): { score: number; reason: string } {
  if (sample.kind !== 'json' || !isObj(sample.value)) return { score: 0, reason: 'not a JSON object' }
  const v = sample.value
  const usage = isObj(v.usage) ? v.usage : null
  if (!usage || !('input_tokens' in usage) || !('output_tokens' in usage)) {
    return { score: 0, reason: 'no usage.input_tokens and usage.output_tokens' }
  }
  if (v.type === 'message') {
    return { score: 0.95, reason: 'message objects with usage.input_tokens and usage.output_tokens' }
  }
  if ('cache_read_input_tokens' in usage || 'cache_creation_input_tokens' in usage) {
    return { score: 0.7, reason: 'usage with input_tokens and Anthropic cache fields, but no type "message"' }
  }
  return { score: 0.3, reason: 'usage.input_tokens and usage.output_tokens without other Messages API fields' }
}

export const anthropicAdapter: Adapter = {
  source: 'D',
  id: 'anthropic-messages',
  version: '1.0.1',
  variants: ['D-json', 'D-jsonl'],
  label: 'Anthropic Messages API responses',
  score: scoreMessage,
  begin(ctx) {
    return {
      push(record) {
        if (record.kind === 'error') return [malformedRow(ctx.variant, record.message, record.raw)]
        if (record.kind !== 'json') return [malformedRow(ctx.variant, 'expected a JSON record', record.row)]
        return [normalizeAnthropicMessage(record.value, ctx.variant)]
      },
      finish: () => [],
    }
  },
}
