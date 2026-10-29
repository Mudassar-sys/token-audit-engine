import { useId, useState } from 'react'
import type { AggregateBucket, AuditSummary } from '../../engine/contracts'
import { formatInt } from '../format'
import { EXCLUDED_HEADING, PARTIAL_TOTAL, bucketValue, excludedGroups } from './display'

export function CoveragePanel({ summary }: { summary: AuditSummary }) {
  const ids = useId()
  const c = summary.coverage
  const items: [string, number, string][] = [
    ['Total rows', c.totalRows, 'cov-total'],
    ['Rows with provider-reported usage', c.rowsWithProviderUsage, 'cov-provider-usage'],
    ['Rows priced, included in cost totals', c.rowsPriced, 'cov-priced'],
    ['Rows Not priced', c.rowsNotPriced, 'cov-not-priced'],
    ['Rows Unresolved', c.rowsUnresolved, 'cov-unresolved'],
    ['Malformed rows', c.rowsMalformed, 'cov-malformed'],
    ['Rows included in row counts', c.rowsInRowCounts, 'cov-row-counts'],
  ]
  return (
    <section className="panel" data-testid="coverage-panel" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Coverage</h2>
      <dl className="stats">
        {items.map(([k, v, testId]) => (
          <div key={k} data-testid={testId}>
            <dt>{k}</dt>
            <dd>{formatInt(v)}</dd>
          </div>
        ))}
      </dl>
      {c.totalRows > c.rowsInRowCounts && (
        <p className="hint">
          {formatInt(c.totalRows - c.rowsInRowCounts)} rows are kept only to reconcile other rows (for example aggregate spans), so they are not included in row counts or cost totals.
        </p>
      )}
      <ExcludedList excluded={summary.excludedFromCost} />
    </section>
  )
}

/** Quantities that are tallied but never priced. Part of the coverage panel. */
function ExcludedList({ excluded }: { excluded: Record<string, number> }) {
  const ids = useId()
  const groups = excludedGroups(excluded)
  return (
    <div className="excluded" data-testid="excluded-from-cost" aria-labelledby={`${ids}-h`} role="group">
      <h3 id={`${ids}-h`}>{EXCLUDED_HEADING}</h3>
      <p>These are tallied here and never folded into token cost.</p>
      <dl className="stats">
        {groups.map((g) => (
          <div key={g.label}>
            <dt>{g.label}</dt>
            <dd>{formatInt(g.count)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export function TotalsPanel({ summary }: { summary: AuditSummary }) {
  const ids = useId()
  const t = summary.totals
  return (
    <section className="panel" data-testid="totals" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Totals</h2>
      <dl className="stats totals">
        <div>
          <dt>Audit value</dt>
          <dd>
            <span className="amount">{t.value.displayUsd}</span> <span className="exact">exact {t.value.exactUsd}</span>
          </dd>
        </div>
        <div>
          <dt>Of which Measured charge</dt>
          <dd>
            <span className="amount">{t.measuredCharge.displayUsd}</span> <span className="exact">exact {t.measuredCharge.exactUsd}</span>
          </dd>
        </div>
        <div>
          <dt>Of which Estimated</dt>
          <dd>
            <span className="amount">{t.estimated.displayUsd}</span> <span className="exact">exact {t.estimated.exactUsd}</span>
          </dd>
        </div>
      </dl>
      {t.partial && (
        <p className="partial" data-testid="partial-total">
          <strong>Partial total.</strong> {t.partialReason ?? 'Some rows in the row counts are not included in cost totals.'}
        </p>
      )}
    </section>
  )
}

type Dimension = 'byModel' | 'byProvider' | 'byDay' | 'byLabel'
const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: 'byModel', label: 'Model' },
  { key: 'byProvider', label: 'Provider' },
  { key: 'byDay', label: 'Day (UTC)' },
  { key: 'byLabel', label: 'Value label' },
]
const MAX_SHOWN = 500

export function AggregatesPanel({ summary }: { summary: AuditSummary }) {
  const ids = useId()
  const [dim, setDim] = useState<Dimension>('byModel')
  const buckets: AggregateBucket[] = summary.aggregates[dim]
  const shown = buckets.slice(0, MAX_SHOWN)
  const dimLabel = DIMENSIONS.find((d) => d.key === dim)?.label ?? ''
  return (
    <section className="panel" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Breakdown</h2>
      <div className="field inline">
        <label htmlFor={`${ids}-dim`}>Group by</label>
        <select id={`${ids}-dim`} value={dim} onChange={(e) => setDim(e.target.value as Dimension)}>
          {DIMENSIONS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      {summary.aggregates.overflowed && <p className="hint">Some groups hit the key limit; later new keys are grouped under "(overflow)".</p>}
      {buckets.some((b) => bucketValue(b).partial) && (
        <p className="hint">A value marked {PARTIAL_TOTAL} leaves out the group's Not priced and Unresolved rows.</p>
      )}
      <div className="table-scroll" tabIndex={0} role="region" aria-label={`Breakdown by ${dimLabel}`}>
        <table className="data">
          <caption>
            By {dimLabel.toLowerCase()}
            {buckets.length > MAX_SHOWN ? `, first ${MAX_SHOWN} of ${formatInt(buckets.length)}` : ''}
          </caption>
          <thead>
            <tr>
              <th scope="col">{dimLabel}</th>
              <th scope="col">Rows</th>
              <th scope="col">Requests</th>
              <th scope="col">Uncached input</th>
              <th scope="col">Cache read</th>
              <th scope="col">Cache write</th>
              <th scope="col">Output</th>
              <th scope="col">Reasoning (in output)</th>
              <th scope="col">Value</th>
              <th scope="col">Not priced</th>
              <th scope="col">Unresolved</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => (
              <tr key={b.key}>
                <th scope="row">{b.key}</th>
                <td className="num">{formatInt(b.rows)}</td>
                <td className="num">{formatInt(b.requests)}</td>
                <td className="num">{formatInt(b.tokens.uncachedInput)}</td>
                <td className="num">{formatInt(b.tokens.cacheRead)}</td>
                <td className="num">{formatInt(b.tokens.cacheWrite)}</td>
                <td className="num">{formatInt(b.tokens.output)}</td>
                <td className="num">{formatInt(b.tokens.reasoning)}</td>
                <BucketValueCell bucket={b} />
                <td className="num">{formatInt(b.rowsNotPriced)}</td>
                <td className="num">{formatInt(b.rowsUnresolved)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function BucketValueCell({ bucket }: { bucket: AggregateBucket }) {
  const { text, partial } = bucketValue(bucket)
  return (
    <td className="num">
      {text}
      {partial && (
        <>
          {' '}
          <span className="partial-tag" data-testid="bucket-partial">
            {PARTIAL_TOTAL}
          </span>
        </>
      )}
    </td>
  )
}
