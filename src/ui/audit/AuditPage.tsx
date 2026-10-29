import { useCallback, useId, useMemo, useState } from 'react'
import { ENGINE_VERSION, SCHEMA_VERSION, type IdentityInputs } from '../../engine/contracts'
import { adapterList, calculationIdentity } from '../../engine/identity'
import { buildReport } from '../../engine/export'
import { priceLabel } from '../../engine/pricing'
import type { OpenAudit } from '../appState'
import type { EngineClient } from '../engineClient'
import { fileStem, saveBlob, saveJson } from '../download'
import { formatBytes, formatInt, formatMs } from '../format'
import { AggregatesPanel, CoveragePanel, ExcludedPanel, TotalsPanel } from './SummaryPanels'
import { RowTable } from './RowTable'
import { RowDrawer } from './RowDrawer'
import { EMPTY_SAVINGS, SavingsPanel, type SavingsState } from './SavingsPanel'

const REPORT_SETTINGS = { displayDecimals: 6, aggregateKeyCap: 5000 }

interface Props {
  client: EngineClient
  audit: OpenAudit | null
}

export function AuditPage({ client, audit }: Props) {
  if (!audit) {
    return (
      <div className="page">
        <h1>Audit</h1>
        <p>
          No audit is open. <a href="#/import">Import a file</a> first.
        </p>
      </div>
    )
  }
  return <OpenAuditView key={audit.summary.auditId} client={client} audit={audit} />
}

function OpenAuditView({ client, audit }: { client: EngineClient; audit: OpenAudit }) {
  const ids = useId()
  const { summary } = audit
  const [openRow, setOpenRow] = useState<number | null>(null)
  const [savings, setSavings] = useState<SavingsState>(EMPTY_SAVINGS)
  const [exportStatus, setExportStatus] = useState('')
  const closeDrawer = useCallback(() => {
    const index = openRow
    setOpenRow(null)
    // If focus had nowhere to return to, put it back on the row that opened the drawer.
    setTimeout(() => {
      const el = document.activeElement
      if (el && el !== document.body && el.tagName !== 'MAIN') return
      document.querySelector<HTMLElement>(`[data-testid="row-table"] [data-row-index="${index}"]`)?.focus()
    }, 0)
  }, [openRow])

  const identityInputs: IdentityInputs = useMemo(
    () => ({
      inputFileSha256: summary.inputFileSha256,
      mapping: summary.mapping,
      adapters: adapterList(summary.variant),
      schemaVersion: SCHEMA_VERSION,
      snapshotSha256: summary.snapshot.sha256,
      baselineModel: savings.baseline ? savings.baselineModel : null,
      routing: savings.routingResult ? savings.routing : null,
      priceOverrides: [],
      reportSettings: REPORT_SETTINGS,
      engineVersion: ENGINE_VERSION,
    }),
    [summary, savings],
  )
  const identity = useMemo(() => calculationIdentity(identityInputs), [identityInputs])
  const stem = fileStem(summary.fileName)

  const exportCsv = async () => {
    setExportStatus('Building the CSV export.')
    try {
      const { blob, rows } = await client.exportCsv()
      saveBlob(blob, `${stem}-audit-rows.csv`)
      setExportStatus(`CSV export saved with ${formatInt(rows)} rows.`)
    } catch (err) {
      setExportStatus(`CSV export failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const exportJson = () => {
    try {
      const savingsOut = savings.baseline || savings.routingResult ? { baseline: savings.baseline, routing: savings.routingResult } : null
      const report = buildReport(summary, identityInputs, new Date().toISOString(), savingsOut)
      saveJson(report, `${stem}-audit-report.json`)
      setExportStatus('JSON report saved.')
    } catch (err) {
      setExportStatus(`JSON report failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="page">
      <h1>Audit</h1>
      <section className="panel provenance" aria-labelledby={`${ids}-prov`}>
        <h2 id={`${ids}-prov`}>Source</h2>
        <dl className="kv">
          <dt>File</dt>
          <dd>
            {summary.fileName}, {formatBytes(summary.fileBytes)}
          </dd>
          <dt>Format</dt>
          <dd>
            <span data-testid="detected-variant">{summary.variant}</span>
            {summary.overridden ? ', chosen by hand' : `, detected with ${Math.round(summary.detection.confidence * 100)}% confidence`}
          </dd>
          <dt>Prices</dt>
          <dd>
            <span className="price-label" data-testid="price-label">{priceLabel(summary.snapshot.date)}</span>, SHA-256 <code className="hash">{summary.snapshot.sha256}</code>
          </dd>
          <dt>Import</dt>
          <dd>
            {formatMs(summary.elapsedMs)}, {formatInt(summary.rowsPerSecond)} rows per second
          </dd>
          <dt>File SHA-256</dt>
          <dd>
            <code className="hash">{summary.inputFileSha256}</code>
          </dd>
        </dl>
      </section>

      <CoveragePanel summary={summary} />
      <TotalsPanel summary={summary} />
      <AggregatesPanel summary={summary} />
      <ExcludedPanel summary={summary} />

      <section className="panel" aria-labelledby={`${ids}-rows`}>
        <h2 id={`${ids}-rows`}>Rows</h2>
        <RowTable client={client} rowCount={summary.coverage.totalRows} onOpen={setOpenRow} />
      </section>

      <SavingsPanel summary={summary} snapshot={audit.pricing.snapshot} value={savings} onChange={setSavings} />

      <section className="panel" aria-labelledby={`${ids}-id`}>
        <h2 id={`${ids}-id`}>Calculation identity</h2>
        <p>
          SHA-256 of the canonical calculation inputs. The same file, mapping, adapters, snapshot and assumptions always give the same identity. The export time is not part of it.
        </p>
        <p>
          <code className="hash" data-testid="calc-identity">
            {identity}
          </code>
        </p>
        <details>
          <summary>Inputs</summary>
          <pre className="json">{JSON.stringify(identityInputs, null, 2)}</pre>
        </details>
      </section>

      <section className="panel" aria-labelledby={`${ids}-exp`}>
        <h2 id={`${ids}-exp`}>Export</h2>
        <div className="actions">
          <button type="button" data-testid="export-csv" onClick={exportCsv}>
            Export rows as CSV
          </button>
          <button type="button" data-testid="export-json" onClick={exportJson}>
            Export JSON report
          </button>
        </div>
        <p role="status" className="status-line">
          {exportStatus}
        </p>
      </section>

      {openRow !== null && <RowDrawer client={client} rowIndex={openRow} onClose={closeDrawer} />}
    </div>
  )
}
