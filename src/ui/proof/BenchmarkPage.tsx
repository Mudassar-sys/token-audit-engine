import { useEffect, useId, useState } from 'react'
import type { EngineClient } from '../engineClient'
import type { LoadedPricing } from '../pricing'
import {
  BENCHMARK_BYTES,
  BENCHMARK_SCENARIO_SHARE,
  BENCHMARK_SCENARIO_TARGET,
  loadRecordedResults,
  loadSavedResults,
  runBenchmark,
  type StoredBenchmarkResult,
} from '../benchmark'
import { saveJson } from '../download'
import { formatBytes, formatInt, formatMs } from '../format'

interface Props {
  client: EngineClient
  pricing: LoadedPricing | null
  importBusy: boolean
  onStart(): void
  onEnd(): void
}

export function BenchmarkPage({ client, pricing, importBusy, onStart, onEnd }: Props) {
  const ids = useId()
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [session, setSession] = useState<StoredBenchmarkResult[]>(() => loadSavedResults())
  const [recorded, setRecorded] = useState<StoredBenchmarkResult[] | null>(null)
  const [recordedError, setRecordedError] = useState(false)

  useEffect(() => {
    let live = true
    loadRecordedResults().then(
      (r) => live && setRecorded(r),
      () => live && setRecordedError(true),
    )
    return () => {
      live = false
    }
  }, [])

  const run = async () => {
    if (!pricing) return
    setRunning(true)
    setError(null)
    onStart()
    try {
      const result = await runBenchmark({ client, pricing, onStatus: setStatus })
      const saved = loadSavedResults()
      setSession((prev) => (saved.some((r) => r.recordedAt === result.recordedAt) ? saved : [...prev, result]))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Exposed for automation, beside window.__benchmarkResult.
      ;(globalThis as { __benchmarkError?: string }).__benchmarkError = message
      setError(message)
      setStatus('')
    } finally {
      setRunning(false)
      onEnd()
    }
  }

  const latest = session[session.length - 1] ?? null

  return (
    <section aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Benchmark</h2>
      <p>
        The run generates a synthetic {formatBytes(BENCHMARK_BYTES)} spend log CSV in this browser, imports it, cancels at half of the bytes and checks that
        no rows of the cancelled import are left. It then imports the file again to completion, runs a routing scenario over every row (all models,
        share {BENCHMARK_SCENARIO_SHARE}, to {BENCHMARK_SCENARIO_TARGET}), and exports the rows as CSV into the browser private file storage, where the
        records are counted back and the file is deleted. Running it replaces the open audit and needs about {formatBytes(BENCHMARK_BYTES * 3)} of free
        local storage, plus room for the exported CSV.
      </p>
      <div className="actions">
        <button type="button" className="primary" data-testid="benchmark-run" onClick={run} disabled={running || importBusy || !pricing}>
          {running ? 'Running' : 'Run benchmark'}
        </button>
        {latest && (
          <button type="button" onClick={() => saveJson(latest, `benchmark-${latest.recordedAt.slice(0, 10)}.json`)}>
            Download latest result as JSON
          </button>
        )}
      </div>
      {!pricing && <p className="hint">Waiting for the pricing snapshot.</p>}
      {importBusy && <p className="hint">An import is running. The benchmark is available when it finishes.</p>}
      <p role="status" aria-live="polite" className="status-line">
        {status}
      </p>
      {error && (
        <p role="alert" className="notice error">
          The benchmark stopped: {error}
        </p>
      )}

      <div data-testid="benchmark-results">
        <h3>Results from this browser</h3>
        {session.length === 0 ? <p>No run yet in this browser.</p> : <ResultsTable results={session} caption="Runs recorded in this browser" />}
        <h3>Recorded results</h3>
        {recordedError && <p>Recorded results could not be loaded.</p>}
        {recorded && recorded.length === 0 && <p>No recorded results are published yet.</p>}
        {recorded && recorded.length > 0 && <ResultsTable results={recorded} caption="Results recorded on reference machines" />}
      </div>
    </section>
  )
}

function show(v: number | string): string {
  return typeof v === 'number' ? formatInt(v) : v
}

const NOT_RECORDED = 'not recorded'

/** A field that results recorded before it was added do not have. */
function later<T>(v: T | undefined, format: (v: T) => string): string {
  return v === undefined ? NOT_RECORDED : format(v)
}

function memory(v: number | string): string {
  return typeof v === 'number' ? formatBytes(v) : v
}

/** Counted value beside the value the generator wrote it to be. */
function versus(counted: number | undefined, expected: number | undefined): string {
  if (counted === undefined) return NOT_RECORDED
  if (expected === undefined) return formatInt(counted)
  return `${formatInt(counted)} (generator wrote ${formatInt(expected)})`
}

function ResultsTable({ results, caption }: { results: StoredBenchmarkResult[]; caption: string }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="data">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Browser</th>
            <th scope="col">CPU cores</th>
            <th scope="col">Memory class</th>
            <th scope="col">File size</th>
            <th scope="col">File seed and SHA-256</th>
            <th scope="col">Pricing snapshot</th>
            <th scope="col">Rows</th>
            <th scope="col">Columns</th>
            <th scope="col">Total time</th>
            <th scope="col">Rows per second</th>
            <th scope="col">Not priced</th>
            <th scope="col">Unresolved</th>
            <th scope="col">Peak memory</th>
            <th scope="col">Cancel response</th>
            <th scope="col">Partial rows deleted in</th>
            <th scope="col">Rows left after cancel</th>
            <th scope="col">Long tasks (50 ms or more)</th>
            <th scope="col">Interactions during import</th>
            <th scope="col">Routing scenario</th>
            <th scope="col">CSV export</th>
            <th scope="col">Export peak memory</th>
            <th scope="col">Rows read back from the export</th>
            <th scope="col">Source mix</th>
          </tr>
        </thead>
        <tbody>
          {[...results].reverse().map((r, i) => (
            <tr key={`${r.recordedAt}-${i}`}>
              <td>{r.recordedAt.replace('T', ' ').slice(0, 19)}</td>
              <td>{r.browser}</td>
              <td className="num">{show(r.cpuCores)}</td>
              <td className="num">{typeof r.memoryClass === 'number' ? `${r.memoryClass} GB` : r.memoryClass}</td>
              <td className="num">{formatBytes(r.fileBytes)}</td>
              <td>
                {r.seed === undefined && r.fileSha256 === undefined
                  ? NOT_RECORDED
                  : `seed ${later(r.seed, String)}, SHA-256 ${later(r.fileSha256, (h) => h)}`}
              </td>
              <td>
                {r.snapshotFile === undefined ? NOT_RECORDED : `${r.snapshotFile}${r.snapshotSha256 ? `, SHA-256 ${r.snapshotSha256}` : ''}`}
              </td>
              <td className="num">
                {formatInt(r.rows)}
                {r.importedRows !== r.rows ? `, ${formatInt(r.importedRows)} imported` : ''}
              </td>
              <td className="num">{formatInt(r.columns)}</td>
              <td className="num">{formatMs(r.totalMs)}</td>
              <td className="num">{formatInt(r.rowsPerSecond)} rows per second</td>
              <td className="num">{versus(r.rowsNotPriced, r.expectedNotPriced)}</td>
              <td className="num">{versus(r.rowsUnresolved, r.expectedUnresolved)}</td>
              <td className="num">{memory(r.peakMemory)}</td>
              <td className="num">{formatMs(r.cancelMs)}</td>
              <td className="num">{later(r.partialDeleteMs, formatMs)}</td>
              <td className="num">{later(r.rowsAfterCancel, show)}</td>
              <td>
                {typeof r.longTasks === 'string'
                  ? r.longTasks
                  : `${formatInt(r.longTasks.count)} tasks, ${formatMs(r.longTasks.totalMs)} in total, longest ${formatMs(r.longTasks.maxMs)}`}
              </td>
              <td>
                {later(r.interactions, (x) =>
                  typeof x === 'string' ? x : `${formatInt(x.count)} interactions, longest ${formatMs(x.maxMs)} to next paint`,
                )}
              </td>
              <td>
                {r.scenarioMs === undefined ? NOT_RECORDED : `${later(r.scenarioRows, formatInt)} rows in ${formatMs(r.scenarioMs)}`}
              </td>
              <td>
                {r.exportMs === undefined
                  ? NOT_RECORDED
                  : `${later(r.exportPath, (p) => (p === 'stream' ? 'streamed to a file' : 'built as a Blob'))}, ${later(r.exportBytes, formatBytes)} in ${formatMs(r.exportMs)}`}
              </td>
              <td className="num">{later(r.exportPeakMemory, memory)}</td>
              <td className="num">{later(r.exportedRows, formatInt)}</td>
              <td>
                {Object.entries(r.sourceMix ?? {})
                  .map(([k, v]) => `${k} ${formatInt(v)}`)
                  .join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
