import type { CacheDuration, ReportedAmount, VariantId } from '../contracts'
import { decimalToScaled, loggedNumberToDecimal, scaledToDecimal } from '../money'
import type { Adapter, AdapterRow, RawRecord } from './types'
import { excludedOf, hasChatUsage, invalidRow, normalizeChatCompletion, notChatCompletion, rejectNonJson, routingHints } from './openaiChat'
import type { ChatUsageOptions, FieldReader, RowNotes } from './openaiChat'

/**
 * Source E: OpenRouter chat completion responses with usage accounting (JSON array or JSONL).
 * Token fields follow the Chat Completions shape; usage.cost is the amount charged in USD credits.
 */

/** Provider = the prefix of the author/slug model id, else the router itself. */
export function openrouterProvider(model: string | null): string {
  const slash = model === null ? -1 : model.indexOf('/')
  return model !== null && slash > 0 ? model.slice(0, slash) : 'openrouter'
}

/** Usage has no TTL split for cache writes, so the duration comes from the model prefix. */
export function openrouterWriteDuration(model: string | null): { duration: CacheDuration; note: string } {
  const provider = openrouterProvider(model)
  if (provider === 'openai') return { duration: '30m', note: 'OpenRouter gives no TTL split, 30m assumed from the openai/ prefix' }
  if (provider === 'anthropic') return { duration: '5m', note: 'OpenRouter gives no TTL split, 5m assumed from the anthropic/ prefix' }
  return { duration: '5m', note: 'OpenRouter gives no TTL split, 5m assumed' }
}

function chatOptions(model: string | null): ChatUsageOptions {
  const w = openrouterWriteDuration(model)
  return { provider: openrouterProvider(model), writeDuration: w.duration, writeDurationNote: w.note, readTier: false }
}

/** Exact sum of two decimal texts. */
function addDecimal(a: string, b: string): string {
  return scaledToDecimal(decimalToScaled(a, 24) + decimalToScaled(b, 24), 24)
}

/** Read a logged money value as exact decimal text; notes an Unresolved reason when it is unusable. */
function money(r: FieldReader, notes: RowNotes, path: string): string | null {
  const v = r.get(path)
  if (v === null || v === undefined) return null
  try {
    const text = loggedNumberToDecimal(v)
    if (text === null) notes.unresolved(`${path} is not a number`)
    else if (text.startsWith('-')) notes.unresolved(`${path} is negative`)
    else return text
  } catch {
    notes.unresolved(`${path} needs more precision than 1e-24 USD`)
  }
  return null
}

/**
 * The charge for the request. With BYOK, usage.cost is only the router fee and the provider bills
 * the inference itself, reported in cost_details.upstream_inference_cost.
 * upstream_inference_cost is filled only for BYOK requests (0 or null otherwise), and the documented
 * usage example shows it without is_byok, so a positive upstream cost with is_byok absent is read
 * as BYOK too.
 */
function reportedCharge(r: FieldReader, notes: RowNotes): ReportedAmount | null {
  const cost = money(r, notes, 'usage.cost')
  const byok = r.get('usage.is_byok')
  const upstream = money(r, notes, 'usage.cost_details.upstream_inference_cost')
  for (const p of ['upstream_inference_prompt_cost', 'upstream_inference_completions_cost', 'server_tool_cost']) r.get(`usage.cost_details.${p}`)
  const upstreamPositive = upstream !== null && decimalToScaled(upstream, 24) > 0n
  const byokLike = (byok === undefined || byok === null) && upstreamPositive
  if (byok === true || byokLike) {
    if (upstream !== null) {
      const field = cost !== null ? 'usage.cost + usage.cost_details.upstream_inference_cost' : 'usage.cost_details.upstream_inference_cost'
      const amountUsd = cost !== null ? addDecimal(cost, upstream) : upstream
      const why = byokLike
        ? 'usage.is_byok absent; upstream_inference_cost is above 0 and is filled only for BYOK requests, so it is added'
        : 'BYOK request'
      notes.mapping.push(`reported = ${field} (${cost ?? 'absent'} + ${upstream}) = ${amountUsd}, ${why}`)
      return { amountUsd, field, kind: 'charge' }
    }
    notes.unresolved('BYOK request without usage.cost_details.upstream_inference_cost; the provider charge is not in the log')
  }
  if (cost === null) {
    notes.mapping.push('reported = none (usage.cost absent)')
    return null
  }
  notes.mapping.push(`reported = usage.cost (${cost})`)
  return { amountUsd: cost, field: 'usage.cost', kind: 'charge' }
}

export function normalizeOpenRouter(value: unknown, variant: VariantId): AdapterRow {
  const out = normalizeChatCompletion(value, variant, chatOptions)
  if ('malformed' in out) return out.malformed
  const { row, reader: r, notes } = out
  r.get('provider')
  const webSearch = r.tokens('usage.server_tool_use.web_search_requests')
  const toolCalls = r.tokens('usage.server_tool_use_details.tool_calls_executed')
  r.tokens('usage.server_tool_use_details.tool_calls_requested')
  if (r.invalid.length > 0) return invalidRow(variant, r)
  const reported = reportedCharge(r, notes)
  return {
    ...row,
    excluded: { ...row.excluded, ...excludedOf([['web_search_requests', webSearch], ['server_tool_calls', toolCalls]]) },
    reported,
    raw: r.raw,
    mapping: notes.mapping,
    flags: notes.flags,
    unresolvedReason: notes.reason(),
  }
}

function scoreOpenRouter(sample: RawRecord): { score: number; reason: string } {
  if (sample.kind !== 'json') return { score: 0, reason: 'not a JSON record' }
  const v = sample.value
  if (!hasChatUsage(v)) return { score: 0, reason: 'no usage.prompt_tokens or usage.completion_tokens' }
  const notChat = notChatCompletion(v)
  if (notChat) return { score: 0, reason: notChat }
  const hints = routingHints(v)
  if (hints.includes('usage.cost')) return { score: 0.95, reason: `chat completion usage with ${hints.join(', ')}` }
  if (hints.length > 0) return { score: 0.85, reason: `chat completion usage with ${hints.join(', ')}` }
  return { score: 0.3, reason: 'chat completion usage without router markers' }
}

export const openrouterAdapter: Adapter = {
  source: 'E',
  id: 'openrouter-chat',
  version: '1.0.0',
  variants: ['E-json', 'E-jsonl'],
  label: 'OpenRouter responses with usage accounting',
  score: scoreOpenRouter,
  begin(ctx) {
    return {
      push(record) {
        const bad = rejectNonJson(record, ctx.variant)
        if (bad) return [bad]
        return [normalizeOpenRouter(record.kind === 'json' ? record.value : null, ctx.variant)]
      },
      finish: () => [],
    }
  },
}
