import type { CustomCsvMapping, Flag, ReportedAmount, Tier, VariantId, TokenClasses } from '../contracts'
import { loggedNumberToDecimal } from '../money'
import type { Adapter, AdapterRow, RawRecord } from './types'
import { ZERO_CACHE_WRITE, malformedRow, tok, toUtcIso } from './types'

/**
 * Source H: any other CSV, read through a user-made column mapping (CustomCsvMapping).
 * Missing cells are Not measured. Non-numeric token cells make the row malformed.
 */

const TIER_NAMES: Record<string, Tier> = {
  standard: 'standard',
  default: 'standard',
  batch: 'batch',
  batches: 'batch',
  flex: 'flex',
  priority: 'priority',
  ultrafast: 'ultrafast',
}

/** Header words that suggest a column holds token counts. */
const TOKEN_HEADER = /token|prompt|completion|input|output/i

/** Match a tier cell to a Tier name, case-insensitively. 'scale' and unknown values return null. */
export function tierFromCell(value: string): Tier | null {
  return TIER_NAMES[value.trim().toLowerCase()] ?? null
}

function cell(row: Record<string, string>, column: string | null): string | null {
  if (column === null) return null
  const v = row[column]
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Why a mapped value is absent: no column chosen, or an empty cell. */
function absentWhy(row: Record<string, string>, column: string | null): string {
  if (column === null) return 'no column mapped'
  return row[column] === undefined ? `column ${column} missing in the row` : `column ${column} empty`
}

function normalize(row: Record<string, string>, m: CustomCsvMapping, variant: VariantId): AdapterRow {
  const raw: Record<string, unknown> = {}
  const bad: string[] = []
  const get = (column: string | null): string | null => {
    const v = cell(row, column)
    if (column !== null && row[column] !== undefined) raw[column] = row[column]
    return v
  }
  const num = (column: string | null): number | null => {
    const v = get(column)
    if (v === null) return null
    const n = tok(v)
    if (Number.isNaN(n)) {
      bad.push(`${column} "${v}"`)
      return null
    }
    return n
  }

  const timestamp = get(m.timestamp)
  const provider = get(m.provider)
  const model = get(m.model)
  const input = num(m.inputTokens)
  const read = num(m.cacheRead)
  const write = num(m.cacheWrite)
  const output = num(m.outputTokens)
  const reasoning = num(m.reasoningTokens)
  const tierCell = get(m.tier)
  const charge = get(m.reportedCharge)

  if (bad.length > 0) return malformedRow(variant, `${bad.join(', ')} is not a non-negative integer`, JSON.stringify(row))

  let reported: ReportedAmount | null = null
  if (charge !== null && m.reportedCharge !== null) {
    let amount: string | null
    try {
      amount = loggedNumberToDecimal(charge.replace(/^\$/, ''))
    } catch {
      amount = null
    }
    if (amount === null) return malformedRow(variant, `${m.reportedCharge} "${charge}" is not a number`, JSON.stringify(row))
    reported = { amountUsd: amount, field: m.reportedCharge, kind: 'charge' }
  }

  const flags: Flag[] = []
  const notMeasured: string[] = []
  const mapping: string[] = []
  let unresolvedReason: string | null = null

  const cacheRead = read ?? 0
  const writeTokens = write ?? 0
  let uncached = 0
  if (input === null) {
    notMeasured.push('uncachedInput')
    mapping.push(`uncachedInput = not measured (${absentWhy(row, m.inputTokens)})`)
  } else if (m.inputIncludesCached) {
    uncached = input - cacheRead - writeTokens
    mapping.push(`uncachedInput = ${m.inputTokens} - ${m.cacheRead ?? '0'} - ${m.cacheWrite ?? '0'} (input includes cached tokens)`)
    if (uncached < 0) {
      uncached = 0
      flags.push('cache_exceeds_input')
      unresolvedReason = `cache tokens (${cacheRead + writeTokens}) exceed input tokens (${input})`
    }
  } else {
    uncached = input
    mapping.push(`uncachedInput = ${m.inputTokens} (input excludes cached tokens)`)
  }

  if (read === null) notMeasured.push('cacheRead')
  else mapping.push(`cacheRead = ${m.cacheRead}`)

  const cacheWrite: TokenClasses['cacheWrite'] = { ...ZERO_CACHE_WRITE }
  if (write === null) {
    notMeasured.push('cacheWrite')
  } else {
    const d = m.cacheWriteDuration ?? '5m'
    cacheWrite[d] = write
    if (m.cacheWriteDuration) mapping.push(`cacheWrite.${d} = ${m.cacheWrite} (duration set in the mapping)`)
    else {
      mapping.push(`cacheWrite.5m = ${m.cacheWrite} (no duration set, 5m assumed)`)
      if (write > 0) flags.push('duration_assumed')
    }
  }

  if (output === null) {
    notMeasured.push('output')
    mapping.push(`output = not measured (${absentWhy(row, m.outputTokens)})`)
  } else mapping.push(`output = ${m.outputTokens}`)

  if (reasoning === null) notMeasured.push('reasoning')
  else {
    mapping.push(`reasoning = ${m.reasoningTokens} (part of output, never added)`)
    if (output !== null && reasoning > output) {
      flags.push('totals_disagree')
      unresolvedReason ??= `reasoning tokens (${reasoning}) exceed output tokens (${output})`
    }
  }

  let tierStated: Tier | null = null
  if (tierCell !== null) {
    const t = tierFromCell(tierCell)
    if (t) {
      tierStated = t
      mapping.push(`tier = ${m.tier} ("${tierCell}")`)
    } else if (tierCell.toLowerCase() === 'scale') {
      raw.service_tier = 'scale'
    } else {
      unresolvedReason ??= `tier value "${tierCell}" is not a known tier`
    }
  }
  if (reported) mapping.push(`reported charge = ${m.reportedCharge}`)
  if (model === null) flags.push('model_missing')

  return {
    timestamp: toUtcIso(timestamp),
    variant,
    provider,
    modelLogged: model,
    tierStated,
    granularity: 'request',
    tokens: { uncachedInput: uncached, cacheRead, cacheWrite, output: output ?? 0, reasoning },
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

function scoreCsv(sample: RawRecord): { score: number; reason: string } {
  if (sample.kind !== 'csv') return { score: 0, reason: 'not a CSV row' }
  const headers = Object.keys(sample.row).filter((h) => h !== '__parsed_extra')
  if (headers.length < 2) return { score: 0, reason: 'fewer than two columns' }
  if (headers.some((h) => TOKEN_HEADER.test(h))) {
    return { score: 0.5, reason: 'CSV with token-like columns; needs a column mapping' }
  }
  return { score: 0.3, reason: 'CSV without token-like column names; needs a column mapping' }
}

export const customCsvAdapter: Adapter = {
  source: 'H',
  id: 'custom-csv',
  version: '1.0.1',
  variants: ['H-csv'],
  label: 'Any other CSV with a column mapping',
  score: scoreCsv,
  begin(ctx) {
    const mapping = ctx.mapping
    return {
      push(record) {
        if (record.kind === 'error') return [malformedRow(ctx.variant, record.message, record.raw)]
        if (record.kind !== 'csv') return [malformedRow(ctx.variant, 'expected a CSV row', '')]
        if (!mapping) return [malformedRow(ctx.variant, 'no column mapping was given', JSON.stringify(record.row))]
        return [normalize(record.row, mapping, ctx.variant)]
      },
      finish: () => [],
    }
  },
}
