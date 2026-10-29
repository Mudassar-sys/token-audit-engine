import { useEffect, useId, useRef, useState } from 'react'
import type { AuditRow, Label } from '../../engine/contracts'
import type { EngineClient } from '../engineClient'
import { useFocusTrap } from '../useFocusTrap'
import { displayUsd, formatInt, rawText } from '../format'
import { EXCLUDED_HEADING, rowValueText } from './display'

interface Props {
  client: EngineClient
  rowIndex: number
  onClose(): void
}

/** Explanation of one row: every input read, every rule applied, every label with its reason. */
export function RowDrawer({ client, rowIndex, onClose }: Props) {
  const ids = useId()
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ index: number; row: AuditRow | null; error: string | null } | null>(null)
  useFocusTrap(ref, true, onClose)

  useEffect(() => {
    let live = true
    client.row(rowIndex).then(
      (row) => live && setState({ index: rowIndex, row, error: null }),
      (err: unknown) => live && setState({ index: rowIndex, row: null, error: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      live = false
    }
  }, [client, rowIndex])

  const loaded = state && state.index === rowIndex ? state : null
  const row = loaded?.row ?? null

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        data-testid="row-drawer"
        tabIndex={-1}
      >
        <div className="drawer-head">
          <h2 id={`${ids}-title`}>Row {rowIndex + 1}</h2>
          <button type="button" data-autofocus onClick={onClose}>
            Close
          </button>
        </div>
        {!loaded && <p role="status">Loading the row.</p>}
        {loaded?.error && <p role="alert">The row could not be read: {loaded.error}</p>}
        {loaded && !loaded.error && !row && <p>This row is not stored.</p>}
        {row && <RowDetails row={row} />}
      </div>
    </div>
  )
}

function LabelText({ label }: { label: Label | undefined }) {
  if (!label) return <span>no label</span>
  return (
    <span>
      <span className="badge" data-kind={label.kind}>
        {label.kind}
      </span>{' '}
      {label.reason}
    </span>
  )
}

function RowDetails({ row }: { row: AuditRow }) {
  const t = row.tokens
  const tokenRows: [string, string, number | null][] = [
    ['uncachedInput', 'Uncached input', t.uncachedInput],
    ['cacheRead', 'Cache read', t.cacheRead],
    ['cacheWrite', 'Cache write, 5 minutes', t.cacheWrite['5m']],
    ['cacheWrite', 'Cache write, 1 hour', t.cacheWrite['1h']],
    ['cacheWrite', 'Cache write, 30 minutes', t.cacheWrite['30m']],
    ['cacheWrite', 'Cache write, 12 hours', t.cacheWrite['12h']],
    ['output', 'Output (inclusive)', t.output],
    ['reasoning', 'Reasoning (part of output)', t.reasoning],
  ]
  const excluded = Object.entries(row.excluded)
  const rawEntries = Object.entries(row.raw)
  return (
    <div className="drawer-body">
      <section aria-label="Value">
        <h3>Value</h3>
        <dl className="kv">
          <dt>Row value</dt>
          <dd>
            <strong data-testid="row-value">{rowValueText(row)}</strong>
            {row.cost.valueUsd !== null && <span className="exact"> exact {row.cost.valueUsd}</span>} <LabelText label={row.cost.label} />
          </dd>
          <dt>Tokens times snapshot rate</dt>
          <dd>
            {row.cost.estimateUsd === null ? 'not computable' : `${displayUsd(row.cost.estimateUsd)} (exact ${row.cost.estimateUsd})`}{' '}
            <LabelText label={row.cost.estimateLabel} />
          </dd>
          <dt>Reported amount</dt>
          <dd>
            {row.reported ? `${displayUsd(row.reported.amountUsd)} (exact ${row.reported.amountUsd}) from ${row.reported.field}, ${row.reported.kind === 'charge' ? 'billed charge' : "gateway's own calculation"}` : 'none in the source'}
          </dd>
          {row.unresolvedReason && (
            <>
              <dt>Needs review</dt>
              <dd>{row.unresolvedReason}</dd>
            </>
          )}
          <dt>Counted in totals</dt>
          <dd>{row.counted ? 'yes' : 'no, kept only to reconcile other rows'}</dd>
        </dl>
        <h4>Formula</h4>
        <p className="formula">{row.cost.formula || 'No formula: the row has no computable estimate.'}</p>
      </section>

      <section aria-label="Pricing">
        <h3>Pricing</h3>
        <dl className="kv">
          <dt>Model as logged</dt>
          <dd>{row.modelLogged ?? 'no model'}</dd>
          <dt>Resolved key</dt>
          <dd>{row.resolvedKey ?? 'none'}</dd>
          <dt>Match</dt>
          <dd>
            {row.match.kind}: {row.match.detail}
            {row.match.source ? ` (${row.match.source})` : ''}
          </dd>
          <dt>Tier</dt>
          <dd>
            {row.tierStated ? `${row.tierStated} as stated` : `${row.tierApplied}, tier assumed`}, applied {row.tierApplied}
          </dd>
          <dt>Snapshot</dt>
          <dd>
            {row.snapshot.date}, file {row.snapshot.file}, SHA-256 <code className="hash">{row.snapshot.sha256}</code>
          </dd>
        </dl>
        {row.cost.appliedRates.length > 0 && (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Applied rates">
            <table className="data">
              <caption>Applied rates, snapshot {row.snapshot.date}</caption>
              <thead>
                <tr>
                  <th scope="col">Class</th>
                  <th scope="col">Tokens</th>
                  <th scope="col">Rate key</th>
                  <th scope="col">USD per token</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {row.cost.appliedRates.map((r, i) => (
                  <tr key={i}>
                    <td>{r.tokenClass}</td>
                    <td className="num">{formatInt(r.tokens)}</td>
                    <td>
                      <code>{r.rateKey}</code>
                    </td>
                    <td className="num">{r.rateUsdPerToken}</td>
                    <td className="num">{r.costUsd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-label="Token classes">
        <h3>Token classes</h3>
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Class</th>
              <th scope="col">Tokens</th>
              <th scope="col">Label</th>
            </tr>
          </thead>
          <tbody>
            {tokenRows.map(([key, name, n]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td className="num">{n === null ? 'not measured' : formatInt(n)}</td>
                <td>
                  <LabelText label={row.labels[key]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Granularity {row.granularity === 'request' ? 'one request' : `time bucket of ${formatInt(row.requests)} requests`}. Not measured:{' '}
          {row.notMeasured.length ? row.notMeasured.join(', ') : 'nothing'}.
        </p>
        {excluded.length > 0 && (
          <p>
            {EXCLUDED_HEADING}: {excluded.map(([k, v]) => `${k} ${formatInt(v)}`).join(', ')}.
          </p>
        )}
      </section>

      <section aria-label="Labels">
        <h3>Every label</h3>
        <dl className="kv">
          {Object.entries(row.labels).map(([k, l]) => (
            <div key={k} className="kv-row">
              <dt>{k}</dt>
              <dd>
                <LabelText label={l} />
              </dd>
            </div>
          ))}
        </dl>
        {row.flags.length > 0 && <p>Flags: {row.flags.join(', ')}.</p>}
      </section>

      <section aria-label="Mapping">
        <h3>Mapping</h3>
        {row.mapping.length ? (
          <ul className="mapping">
            {row.mapping.map((m, i) => (
              <li key={i}>
                <code>{m}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>No mapping lines for this row.</p>
        )}
      </section>

      <section aria-label="Raw fields">
        <h3>Raw fields read</h3>
        <p>
          Source format {row.variant}, provider {row.provider ?? 'unknown'}, time {row.timestamp ?? 'not in the source'}.
        </p>
        {rawEntries.length ? (
          <table className="data raw">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              {rawEntries.map(([k, v]) => (
                <tr key={k}>
                  <th scope="row">
                    <code>{k}</code>
                  </th>
                  <td>
                    <code>{rawText(v)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No raw fields recorded.</p>
        )}
      </section>
    </div>
  )
}
