import { ENGINE_VERSION, IdentityInputs, Report, SCHEMA_VERSION, type AuditRow, type AuditSummary } from './contracts'
import { ENGINE_FINGERPRINT } from './fingerprint.generated'
import { calculationIdentity, canonicalIdentityInputs } from './identity'
import { formatUsd, usdToFemto } from './money'
import { priceLabel } from './pricing'

/** Columns of the row CSV export, in order. */
export const CSV_COLUMNS = [
  'rowIndex',
  'timestamp',
  'variant',
  'provider',
  'modelLogged',
  'resolvedKey',
  'matchKind',
  'matchDetail',
  'tierStated',
  'tierApplied',
  'granularity',
  'requests',
  'includedInRowCounts',
  'includedInCostTotals',
  'uncachedInput',
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h',
  'cacheWrite30m',
  'cacheWrite12h',
  'output',
  'reasoning',
  'notMeasured',
  'excluded',
  'reportedAmountUsd',
  'reportedKind',
  'reportedField',
  'estimateUsd',
  'estimateLabel',
  'valueUsd',
  'valueLabel',
  'valueReason',
  'formula',
  'flags',
  'unresolvedReason',
  'mapping',
  'snapshotDate',
  'snapshotSha256',
] as const

const FORMULA_START = /^[=+\-@\t\r]/
const NEEDS_QUOTES = /[",\r\n]/

/**
 * One CSV cell. Text that a spreadsheet could run as a formula (starting with
 * =, +, -, @, tab or carriage return) gets a leading single quote. Then RFC 4180
 * quoting applies when the cell holds a comma, quote, CR or LF.
 * Numbers and booleans produced by the engine are written as is.
 */
export function csvEscapeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  let s: string
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
    s = String(v)
  } else {
    s = typeof v === 'string' ? v : JSON.stringify(v)
    if (FORMULA_START.test(s)) s = `'${s}`
  }
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function cellsOf(row: AuditRow): unknown[] {
  const t = row.tokens
  const values: Record<(typeof CSV_COLUMNS)[number], unknown> = {
    rowIndex: row.rowIndex,
    timestamp: row.timestamp,
    variant: row.variant,
    provider: row.provider,
    modelLogged: row.modelLogged,
    resolvedKey: row.resolvedKey,
    matchKind: row.match.kind,
    matchDetail: row.match.detail,
    tierStated: row.tierStated,
    tierApplied: row.tierApplied,
    granularity: row.granularity,
    requests: row.requests,
    includedInRowCounts: row.counted,
    includedInCostTotals: row.counted && row.cost.valueUsd !== null,
    uncachedInput: t.uncachedInput,
    cacheRead: t.cacheRead,
    cacheWrite5m: t.cacheWrite['5m'],
    cacheWrite1h: t.cacheWrite['1h'],
    cacheWrite30m: t.cacheWrite['30m'],
    cacheWrite12h: t.cacheWrite['12h'],
    output: t.output,
    reasoning: t.reasoning,
    notMeasured: row.notMeasured.join(';'),
    excluded: Object.keys(row.excluded).length ? JSON.stringify(row.excluded) : '',
    reportedAmountUsd: row.reported?.amountUsd ?? null,
    reportedKind: row.reported?.kind ?? null,
    reportedField: row.reported?.field ?? null,
    estimateUsd: row.cost.estimateUsd,
    estimateLabel: row.cost.estimateLabel.kind,
    valueUsd: row.cost.valueUsd,
    valueLabel: row.cost.label.kind,
    valueReason: row.cost.label.reason,
    formula: row.cost.formula,
    flags: row.flags.join(';'),
    unresolvedReason: row.unresolvedReason,
    mapping: row.mapping.join(' | '),
    snapshotDate: row.snapshot.date,
    snapshotSha256: row.snapshot.sha256,
  }
  return CSV_COLUMNS.map((c) => values[c])
}

/** Header line of the row CSV export, ending in CRLF. */
export const CSV_HEADER = `${CSV_COLUMNS.join(',')}\r\n`

/** One audit row as a CSV line, ending in CRLF (RFC 4180). */
export function auditRowToCsvLine(row: AuditRow): string {
  return `${cellsOf(row).map(csvEscapeCell).join(',')}\r\n`
}

/** Replace BigInt values with decimal text so a structure can be written as JSON. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(toJsonSafe)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toJsonSafe(v)
    return out
  }
  return value
}

function redisplay(pair: { exactUsd: string; displayUsd: string }, decimals: number) {
  return { exactUsd: pair.exactUsd, displayUsd: formatUsd(usdToFemto(pair.exactUsd), decimals) }
}

/**
 * Build the JSON report. Exact amount strings sit beside display values rounded to
 * the report setting. The export time is recorded but never feeds the identity hash.
 */
export function buildReport(
  summary: AuditSummary,
  identityInputs: IdentityInputs,
  exportedAt: string | Date,
  savings: unknown,
): Report {
  // Stored in canonical form, so sha256 of the canonical JSON of `inputs` is the identity itself.
  const inputs = canonicalIdentityInputs(IdentityInputs.parse(identityInputs))
  if (inputs.engineVersion !== ENGINE_VERSION || inputs.schemaVersion !== SCHEMA_VERSION || inputs.engineFingerprint !== ENGINE_FINGERPRINT) {
    throw new Error('The identity inputs name another engine build than the one writing this report.')
  }
  const decimals = inputs.reportSettings.displayDecimals
  const report: Report = {
    title: 'Token cost audit report',
    engineVersion: ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: typeof exportedAt === 'string' ? exportedAt : exportedAt.toISOString(),
    calculationIdentity: { sha256: calculationIdentity(inputs), inputs },
    provenance: {
      fileName: summary.fileName,
      fileBytes: summary.fileBytes,
      variant: summary.variant,
      detection: {
        variant: summary.detection.variant,
        confidence: summary.detection.confidence,
        overridden: summary.overridden,
      },
      snapshot: summary.snapshot,
      priceLabel: priceLabel(summary.snapshot.date),
      engineFingerprint: inputs.engineFingerprint,
    },
    coverage: summary.coverage,
    totals: {
      value: redisplay(summary.totals.value, decimals),
      measuredCharge: redisplay(summary.totals.measuredCharge, decimals),
      estimated: redisplay(summary.totals.estimated, decimals),
      partial: summary.totals.partial,
      partialReason: summary.totals.partialReason,
    },
    aggregates: summary.aggregates,
    excludedFromCost: summary.excludedFromCost,
    savings: savings === undefined || savings === null ? null : toJsonSafe(savings),
  }
  return Report.parse(report)
}
