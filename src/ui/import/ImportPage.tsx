import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { VariantId, type CustomCsvMapping } from '../../engine/contracts'
import { VARIANTS } from '../../engine/adapters'
import { effectiveVariant, SAMPLE_BYTES, type ImportState } from '../appState'
import type { EngineClient } from '../engineClient'
import type { LoadedPricing } from '../pricing'
import { formatBytes, formatInt } from '../format'
import { MappingStep, mappingProblem } from './MappingStep'

interface Props {
  client: EngineClient
  state: ImportState
  pricing: LoadedPricing | null
  /** True while the benchmark uses the engine. */
  busy: boolean
  onChooseFile(file: File | null): void
  onPatch(p: Partial<ImportState>): void
  onGenerateSample(): void
  onImport(): void
  onCancel(): void
  onClear(): void
}

function variantLabel(id: VariantId): string {
  const v = VARIANTS.find((x) => x.id === id)
  return v ? `${v.label} (${id})` : id
}

export function ImportPage({ client, state, pricing, busy, onChooseFile, onPatch, onGenerateSample, onImport, onCancel, onClear }: Props) {
  const ids = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [estimate, setEstimate] = useState<{ usage: number | null; quota: number | null } | null>(null)
  const running = state.phase !== 'idle'
  const generating = state.sampleBytes !== null

  const refreshEstimate = useCallback(() => {
    client.estimate().then(setEstimate, () => setEstimate({ usage: null, quota: null }))
  }, [client])
  useEffect(() => {
    if (state.phase === 'idle') refreshEstimate()
  }, [refreshEstimate, state.phase, state.notice])

  // The sample fills the file slot; the input itself cannot hold a generated file, so clear its own value.
  useEffect(() => {
    if (fileRef.current && state.file && fileRef.current.files?.[0] !== state.file) fileRef.current.value = ''
  }, [state.file])

  const variant = effectiveVariant(state)
  const needsMapping = variant === 'H-csv'
  const headers = state.detection?.csvHeaders ?? null
  const mappingIssue = needsMapping ? (headers ? mappingProblem(state.mapping) : 'The mapping step needs a CSV file with a header row.') : null
  const canImport = !running && !busy && !generating && state.file !== null && state.detection !== null && variant !== null && pricing !== null && mappingIssue === null

  const onMapping = useCallback((m: CustomCsvMapping) => onPatch({ mapping: m }), [onPatch])

  return (
    <div className="page">
      <h1>Import a log file</h1>
      <p className="lede">The file is read in this browser tab by a background worker. Rows are stored locally so the audit can be explored and exported.</p>

      <section className="panel" aria-labelledby={`${ids}-file`}>
        <h2 id={`${ids}-file`}>Choose a file</h2>
        <div className="field">
          <label htmlFor={`${ids}-input`}>Log file (JSON, JSONL or CSV)</label>
          <input
            id={`${ids}-input`}
            ref={fileRef}
            data-testid="file-input"
            type="file"
            accept=".json,.jsonl,.ndjson,.csv,.txt,application/json,text/csv"
            disabled={running || generating}
            onChange={(e) => onChooseFile(e.target.files?.[0] ?? null)}
          />
        </div>
        {state.file && (
          <p className="file-line">
            Selected: <strong>{state.file.name}</strong>, {formatBytes(state.file.size)}
          </p>
        )}
        <div className="actions">
          <button type="button" data-testid="generate-sample" onClick={onGenerateSample} disabled={running || generating || busy}>
            Generate 200MB sample
          </button>
        </div>
        {generating && (
          <div className="progress-block">
            <label htmlFor={`${ids}-sample`}>Generating sample</label>
            <progress id={`${ids}-sample`} max={SAMPLE_BYTES} value={state.sampleBytes ?? 0} />
            <span>
              {formatBytes(state.sampleBytes ?? 0)} of {formatBytes(SAMPLE_BYTES)}
            </span>
          </div>
        )}
      </section>

      {(state.detecting || state.detection) && (
        <section className="panel" aria-labelledby={`${ids}-det`}>
          <h2 id={`${ids}-det`}>Detected format</h2>
          {state.detecting && <p role="status">Reading the start of the file.</p>}
          {state.detection && (
            <>
              <div data-testid="detected-variant" className="detected" role="status">
                {state.detection.variant ? (
                  <p>
                    <strong>{variantLabel(state.detection.variant)}</strong>, confidence {Math.round(state.detection.confidence * 100)}%.
                  </p>
                ) : (
                  <p>
                    <strong>Not supported yet.</strong>
                  </p>
                )}
                <p className="reason">{state.detection.reason}</p>
              </div>
              <div className="field">
                <label htmlFor={`${ids}-override`}>Format to use</label>
                <select
                  id={`${ids}-override`}
                  data-testid="variant-override"
                  value={state.override ?? ''}
                  disabled={running}
                  onChange={(e) => onPatch({ override: e.target.value ? VariantId.parse(e.target.value) : null })}
                >
                  <option value="">{state.detection.variant ? `Use detected: ${state.detection.variant}` : 'Nothing detected'}</option>
                  {VARIANTS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} ({v.id})
                    </option>
                  ))}
                </select>
              </div>
              {state.detection.candidates.length > 1 && (
                <details>
                  <summary>Other candidates</summary>
                  <ul>
                    {state.detection.candidates.map((c) => (
                      <li key={c.variant}>
                        {c.variant}: {Math.round(c.confidence * 100)}%
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </section>
      )}

      {needsMapping && state.file && headers && (
        <MappingStep client={client} file={state.file} headers={headers} mapping={state.mapping} onChange={onMapping} />
      )}

      <section className="panel" aria-labelledby={`${ids}-run`}>
        <h2 id={`${ids}-run`}>Run the import</h2>
        {!pricing && <p>Loading the pricing snapshot.</p>}
        {mappingIssue && <p className="hint">{mappingIssue}</p>}
        {state.detection && !variant && <p className="hint">This file is not supported yet. Pick a format above if you know it.</p>}
        <p className="storage">
          Local storage:{' '}
          {estimate && estimate.quota !== null
            ? `${formatBytes(estimate.usage ?? 0)} used of ${formatBytes(estimate.quota)} available to this site.`
            : 'the browser does not report an estimate.'}
          {state.file && ` An import needs up to ${formatBytes(state.file.size * 3)} for this file.`}
        </p>
        <div className="actions">
          <button type="button" className="primary" data-testid="import-button" onClick={onImport} disabled={!canImport}>
            Import
          </button>
          {running && (
            <button type="button" data-testid="cancel-button" onClick={onCancel} disabled={state.phase === 'cancelling'}>
              {state.phase === 'cancelling' ? 'Cancelling' : 'Cancel'}
            </button>
          )}
        </div>
        {busy && <p className="hint">The benchmark is running. Import is available when it finishes.</p>}
        <ProgressView state={state} />
        {state.notice && (
          <p className={`notice ${state.notice.kind}`} role={state.notice.kind === 'error' ? 'alert' : 'status'}>
            {state.notice.text}
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby={`${ids}-sup`}>
        <h2 id={`${ids}-sup`}>Supported formats</h2>
        <ul className="variants">
          {VARIANTS.map((v) => (
            <li key={v.id}>
              <span className="variant-id">{v.id}</span> {v.label}
            </li>
          ))}
        </ul>
        <p>Anything else shows: not supported yet.</p>
      </section>

      <section className="panel" aria-labelledby={`${ids}-clear`}>
        <h2 id={`${ids}-clear`}>Local data</h2>
        <p>Imported rows stay in this browser until you clear them. Clearing also removes saved column mappings and saved benchmark results.</p>
        <button type="button" data-testid="clear-data" onClick={onClear} disabled={running || busy}>
          Clear local data
        </button>
      </section>
    </div>
  )
}

function ProgressView({ state }: { state: ImportState }) {
  const p = state.progress
  const [announced, setAnnounced] = useState('')
  const lastStep = useRef(-1)
  const pct = p && p.bytesTotal > 0 ? Math.min(100, Math.floor((p.bytesRead / p.bytesTotal) * 100)) : 0

  // Announce in steps of 10% so screen readers are not flooded by every update.
  useEffect(() => {
    if (state.phase === 'idle') {
      lastStep.current = -1
      return
    }
    const step = Math.floor(pct / 10)
    if (step !== lastStep.current) {
      lastStep.current = step
      setAnnounced(`Import ${pct}% done.`)
    }
  }, [pct, state.phase])

  if (state.phase === 'idle' && !p) return null
  return (
    <div className="progress-block" data-testid="progress">
      <label htmlFor="import-progress">Import progress</label>
      <progress id="import-progress" max={100} value={pct} />
      {p && (
        <p className="progress-text">
          {formatBytes(p.bytesRead)} of {formatBytes(p.bytesTotal)} read, {formatInt(p.rows)} rows, {formatInt(p.rowsPerSecond)} rows per second
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {state.phase === 'cancelling' ? 'Cancelling the import.' : announced}
      </p>
    </div>
  )
}
