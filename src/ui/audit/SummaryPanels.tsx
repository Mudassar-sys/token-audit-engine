import { useId, useState } from 'react'
import type { AggregateBucket, AuditSummary } from '../../engine/contracts'
import { displayUsd, formatInt } from '../format'

export function CoveragePanel({ summary }: { summary: AuditSummary }) {
  const ids = useId()
  const c = summary.coverage
  const items: [string, number, string][] = [
    ['Total rows', c.totalRows, 'cov-total'],
    ['Rows with provider-reported usage', c.rowsWithProviderUsage, 'cov-provider-usage'],
    ['Rows priced', c.rowsPriced, 'cov-priced'],
    ['Rows Not priced', c.rowsNotPriced, 'cov-not-priced'],
    ['Rows Unresolved', c.rowsUnresolved, 'cov-unresolved'],
    ['Malformed rows', c.rowsMalformed, 'cov-malformed'],
    ['Counted rows', c.countedRows, 'cov-counted'],
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
      {c.totalRows > c.countedRows && (
        <p className="hint">
          {formatInt(c.totalRows - c.countedRows)} rows are kept only to reconcile other rows (for example aggregate spans) and are not counted.
        </p>
      )}
    </section>
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
          <strong>Partial total.</strong> {t.partialReason ?? 'Some counted rows have no value.'}
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
      {summary.aggregates.overflowed && <p className="hint">Some groups hit the key limit; later new keys are counted under "(overflow)".</p>}
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
                <td className="num">{displayUsd(b.valueUsd)}</td>
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

export function ExcludedPanel({ summary }: { summary: AuditSummary }) {
  const ids = useId()
  const entries = Object.entries(summary.excludedFromCost).filter(([, v]) => v > 0)
  return (
    <section className="panel" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Counted but not priced</h2>
      <p>Audio, image and video tokens, web search requests, tool sessions and storage are counted here and never folded into token cost.</p>
      {entries.length === 0 ? (
        <p>None in this file.</p>
      ) : (
        <dl className="stats">
          {entries.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{formatInt(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}
