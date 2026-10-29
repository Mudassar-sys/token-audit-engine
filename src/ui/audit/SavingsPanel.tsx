import { useId, useMemo, useState } from 'react'
import {
  CacheDuration,
  DEFAULT_DURATION_MAP,
  type AuditSummary,
  type DurationMap,
  type RoutingAssumptions,
  type ScenarioResult,
} from '../../engine/contracts'
import { ASSUMPTION_LABEL, canonicalRoutingAssumptions } from '../../engine/savings'
import type { EngineClient } from '../engineClient'
import { loadFrozenSnapshot, type LoadedPricing } from '../pricing'
import { formatInt } from '../format'
import { PARTIAL_TOTAL, loggedValue } from './display'

/** The inputs of the scenario that produced `result`. */
export interface ScenarioInputs {
  baselineKey: string | null
  routing: RoutingAssumptions | null
  durationMap: DurationMap
}

export interface SavingsState {
  inputs: ScenarioInputs | null
  /** The exact result shown in the panel. The JSON report carries this same object. */
  result: ScenarioResult | null
}

export const EMPTY_SAVINGS: SavingsState = { inputs: null, result: null }

interface Props {
  client: EngineClient
  summary: AuditSummary
  /** The pricing loaded when the audit ran. Used only when its SHA-256 is the audit's snapshot. */
  pricing: LoadedPricing
  value: SavingsState
  onChange(s: SavingsState): void
}

const BANDS = ['<1k', '1k-10k', '10k-100k', '>=100k']
const DECIMAL = /^\d+(\.\d{1,6})?$/
const NON_MODEL_KEYS = new Set(['(overflow)', '(no model)'])
const DURATIONS = CacheDuration.options
const DURATION_NAMES: Record<CacheDuration, string> = { '5m': '5 minutes', '1h': '1 hour', '30m': '30 minutes', '12h': '12 hours' }

interface Draft {
  baselineModel: string
  sourceModels: string[]
  inputBands: string[]
  targetModel: string
  eligibleShare: string
  outputLengthRatio: string
  tokenizerRatio: string
  retryFallbackRate: string
  routingOverheadTokens: string
  calibrationPassRate: string
  durationMap: DurationMap
}

const initialDraft: Draft = {
  baselineModel: '',
  sourceModels: [],
  inputBands: [],
  targetModel: '',
  eligibleShare: '0.5',
  outputLengthRatio: '1',
  tokenizerRatio: '1',
  retryFallbackRate: '0',
  routingOverheadTokens: '0',
  calibrationPassRate: '',
  durationMap: DEFAULT_DURATION_MAP,
}

/** Routing assumptions from the form, or null when no target is chosen. */
export function draftToAssumptions(d: Omit<Draft, 'baselineModel' | 'durationMap'>): { value: RoutingAssumptions | null; error: string | null } {
  if (!d.targetModel.trim()) return { value: null, error: null }
  const decimals: [keyof typeof d, string][] = [
    ['eligibleShare', 'Eligible share'],
    ['outputLengthRatio', 'Output length ratio'],
    ['tokenizerRatio', 'Tokenizer ratio'],
    ['retryFallbackRate', 'Retry and fallback rate'],
  ]
  for (const [k, name] of decimals) {
    if (!DECIMAL.test(String(d[k]).trim())) return { value: null, error: `${name} must be a decimal such as 0.5, with at most 6 decimal places.` }
  }
  if (!/^\d+$/.test(d.routingOverheadTokens.trim())) return { value: null, error: 'Routing overhead must be a whole number of tokens.' }
  const pass = d.calibrationPassRate.trim()
  if (pass && !DECIMAL.test(pass)) return { value: null, error: 'Calibration pass rate must be a decimal such as 0.9, or empty.' }
  // Canonical form, so click order or '0.50' versus '0.5' never changes the calculation identity.
  return {
    error: null,
    value: canonicalRoutingAssumptions({
      sourceModels: d.sourceModels,
      inputBands: d.inputBands,
      targetModel: d.targetModel.trim(),
      eligibleShare: d.eligibleShare.trim(),
      outputLengthRatio: d.outputLengthRatio.trim(),
      tokenizerRatio: d.tokenizerRatio.trim(),
      retryFallbackRate: d.retryFallbackRate.trim(),
      routingOverheadTokens: Number(d.routingOverheadTokens.trim()),
      calibrationPassRate: pass || null,
    }),
  }
}

/**
 * What-if modelling. Every stored row is repriced in the worker with the audit's own snapshot and the
 * same row pricer the import used. Every result is Estimated and quality is unverified.
 */
export function SavingsPanel({ client, summary, pricing, value, onChange }: Props) {
  const ids = useId()
  const modelKeys = useMemo(() => Object.keys(pricing.snapshot.models).sort(), [pricing])
  const sourceModels = useMemo(
    () => summary.aggregates.byModel.map((b) => b.key).filter((k) => !NON_MODEL_KEYS.has(k)).sort(),
    [summary],
  )
  const [draft, setDraft] = useState<Draft>(() => ({
    ...initialDraft,
    baselineModel: value.inputs?.baselineKey ?? '',
    durationMap: value.inputs?.durationMap ?? DEFAULT_DURATION_MAP,
  }))
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ rowsDone: number; rowsTotal: number } | null>(null)
  const running = progress !== null

  const run = async () => {
    const baselineKey = draft.baselineModel.trim() || null
    const { value: routing, error: routingError } = draftToAssumptions(draft)
    if (routingError) return setError(routingError)
    if (!baselineKey && !routing) return setError('Choose a baseline model, a target model, or both.')
    setError(null)
    setProgress({ rowsDone: 0, rowsTotal: summary.coverage.totalRows })
    try {
      // The audit's frozen snapshot, never a newer one.
      const snapshot = await loadFrozenSnapshot(summary.snapshot, pricing)
      const { file, date, sha256, commit } = summary.snapshot
      const inputs: ScenarioInputs = { baselineKey, routing, durationMap: draft.durationMap }
      const result = await client.scenario({ snapshot, snapshotMeta: { file, date, sha256, commit }, ...inputs }, setProgress)
      onChange({ inputs, result })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProgress(null)
    }
  }

  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item])
  const setField = (k: Exclude<keyof Draft, 'sourceModels' | 'inputBands' | 'durationMap'>, v: string) => setDraft((d) => ({ ...d, [k]: v }))
  const setDuration = (from: CacheDuration, to: CacheDuration) => setDraft((d) => ({ ...d, durationMap: { ...d.durationMap, [from]: to } }))

  return (
    <section className="panel" data-testid="savings-panel" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Savings modeller</h2>
      <p>
        These are what-if numbers. Every stored row is repriced one by one with this audit's snapshot and the same row pricer the import used. Every result is
        Estimated. Quality on another model is unverified.
      </p>
      <datalist id={`${ids}-models`}>
        {modelKeys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>

      <h3>Baseline</h3>
      <div className="field">
        <label htmlFor={`${ids}-base`}>Baseline model (optional)</label>
        <input
          id={`${ids}-base`}
          data-testid="baseline-model"
          list={`${ids}-models`}
          value={draft.baselineModel}
          onChange={(e) => setField('baselineModel', e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <h3>Routing scenario</h3>
      <fieldset>
        <legend>Source models (none ticked means all)</legend>
        <div className="checks">
          {sourceModels.map((m) => (
            <label key={m} className="check">
              <input
                type="checkbox"
                data-testid={`source-model-${m}`}
                checked={draft.sourceModels.includes(m)}
                onChange={() => setDraft((d) => ({ ...d, sourceModels: toggle(d.sourceModels, m) }))}
              />
              {m}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Input bands, tokens per request (none ticked means all)</legend>
        <div className="checks">
          {BANDS.map((b) => (
            <label key={b} className="check">
              <input type="checkbox" checked={draft.inputBands.includes(b)} onChange={() => setDraft((d) => ({ ...d, inputBands: toggle(d.inputBands, b) }))} />
              {b}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${ids}-target`}>Target model (optional)</label>
          <input
            id={`${ids}-target`}
            data-testid="target-model"
            list={`${ids}-models`}
            value={draft.targetModel}
            onChange={(e) => setField('targetModel', e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <NumberField id={`${ids}-share`} label="Eligible share (0 to 1)" value={draft.eligibleShare} onChange={(v) => setField('eligibleShare', v)} />
        <NumberField id={`${ids}-out`} label="Output length ratio" value={draft.outputLengthRatio} onChange={(v) => setField('outputLengthRatio', v)} />
        <NumberField id={`${ids}-tok`} label="Tokenizer ratio" value={draft.tokenizerRatio} onChange={(v) => setField('tokenizerRatio', v)} />
        <NumberField id={`${ids}-retry`} label="Retry and fallback rate" value={draft.retryFallbackRate} onChange={(v) => setField('retryFallbackRate', v)} />
        <NumberField id={`${ids}-over`} label="Routing overhead tokens per request" value={draft.routingOverheadTokens} onChange={(v) => setField('routingOverheadTokens', v)} />
        <NumberField id={`${ids}-pass`} label="Calibration pass rate (optional)" value={draft.calibrationPassRate} onChange={(v) => setField('calibrationPassRate', v)} />
      </div>
      <p className="hint">Each value above is a {ASSUMPTION_LABEL}.</p>

      <fieldset>
        <legend>Cache write durations on a model of another provider family ({ASSUMPTION_LABEL})</legend>
        <div className="form-grid">
          {DURATIONS.map((from) => (
            <div className="field" key={from}>
              <label htmlFor={`${ids}-dur-${from}`}>{DURATION_NAMES[from]} becomes</label>
              <select id={`${ids}-dur-${from}`} data-testid={`duration-${from}`} value={draft.durationMap[from]} onChange={(e) => setDuration(from, e.target.value as CacheDuration)}>
                {DURATIONS.map((to) => (
                  <option key={to} value={to}>
                    {DURATION_NAMES[to]}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <p className="hint">Used only when tokens move between provider families. The same family keeps its durations.</p>
      </fieldset>

      <button type="button" data-testid="run-savings" onClick={run} disabled={running}>
        Run the savings model
      </button>
      <p role="status" className="status-line" data-testid="savings-progress">
        {progress ? `Repricing rows: ${formatInt(progress.rowsDone)} of ${formatInt(progress.rowsTotal)}.` : ''}
      </p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {value.result && <ScenarioView result={value.result} />}
    </section>
  )
}

/** Every figure of a scenario result, as the engine computed it. */
export function ScenarioView({ result }: { result: ScenarioResult }) {
  const leftOut = result.rowsLeftOut.filter((r) => r.rows > 0)
  const { text: listText, partial } = loggedValue(result.listOriginal, leftOut)
  const fmtMap = (m: DurationMap) => DURATIONS.map((d) => `${DURATION_NAMES[d]} becomes ${DURATION_NAMES[m[d]]}`).join(', ')
  return (
    <div className="result" data-testid="savings-result">
      <p className="badge-line">
        <span className="badge" data-kind={result.label.kind}>
          {result.label.kind}
        </span>{' '}
        {result.label.reason}. Quality: <span data-testid="savings-quality">{result.quality}</span>.
      </p>
      <dl className="stats">
        <div>
          <dt>List price of compared rows</dt>
          <dd>
            <span data-testid="list-original">{listText}</span>
            {partial && (
              <>
                {' '}
                <span className="partial-tag" data-testid="logged-partial">
                  {PARTIAL_TOTAL}
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Rows compared</dt>
          <dd>
            {formatInt(result.rowsCompared)} of {formatInt(result.rowsRead)}
          </dd>
        </div>
      </dl>

      {result.baseline && (
        <>
          <h4>Baseline: {result.baseline.key}</h4>
          <dl className="stats" data-testid="baseline-result">
            <div>
              <dt>{result.baseline.label}</dt>
              <dd data-testid="baseline-value">{result.baseline.value.displayUsd}</dd>
            </div>
            <div>
              <dt>List price of the same rows</dt>
              <dd data-testid="baseline-compared">{result.baseline.comparedOriginal.displayUsd}</dd>
            </div>
            <div>
              <dt>Baseline minus list price</dt>
              <dd data-testid="baseline-difference">{result.baseline.difference.displayUsd}</dd>
            </div>
          </dl>
          <p>
            The baseline priced {formatInt(result.baseline.rowsPriced)} rows. {formatInt(result.baseline.rowsNotPriced)} compared rows have no baseline price and are
            left out of both sides.
          </p>
          <Notes items={result.baseline.notes} />
        </>
      )}

      {result.routing && (
        <>
          <h4>Routing to {result.routing.targetKey}</h4>
          <dl className="stats" data-testid="routing-result">
            <div>
              <dt>Scenario value</dt>
              <dd data-testid="routing-scenario">{result.routing.scenario.displayUsd}</dd>
            </div>
            <div>
              <dt>Savings (negative means the scenario costs more)</dt>
              <dd data-testid="routing-savings">{result.routing.savings.displayUsd}</dd>
            </div>
            <div>
              <dt>Eligible rows</dt>
              <dd data-testid="routing-eligible">{formatInt(result.routing.eligibleRows)}</dd>
            </div>
            <div>
              <dt>Kept at original cost</dt>
              <dd data-testid="routing-fallback">{formatInt(result.routing.targetRateFallbackRows)}</dd>
            </div>
          </dl>
          <Notes items={result.routing.notes} />
        </>
      )}

      {result.loggedVersusList && (
        <div data-testid="logged-versus-list">
          <h4>{result.loggedVersusList.label}</h4>
          <p>
            Over {formatInt(result.loggedVersusList.rows)} rows with a Measured charge: logged {result.loggedVersusList.logged.displayUsd}, list price{' '}
            {result.loggedVersusList.list.displayUsd}, difference {result.loggedVersusList.difference.displayUsd}. This is never included in savings.
          </p>
        </div>
      )}

      <h4>Rows left out</h4>
      {leftOut.length ? (
        <ul data-testid="rows-left-out">
          {leftOut.map((r) => (
            <li key={r.reason}>
              {formatInt(r.rows)} {r.rows === 1 ? 'row' : 'rows'}: {r.reason}
            </li>
          ))}
        </ul>
      ) : (
        <p data-testid="rows-left-out">None.</p>
      )}

      {result.timeBucketRows > 0 && (
        <p data-testid="time-bucket-note">
          {formatInt(result.timeBucketRows)} time-bucket rows have no request sizes, so they are priced at base rates.
          {result.longContextUncertain ? ' The long-context result is uncertain.' : ''}
        </p>
      )}

      <p>
        Cache write durations ({ASSUMPTION_LABEL}): {fmtMap(result.durationMap)}.
      </p>
      <details>
        <summary>Assumptions</summary>
        <ul>
          {result.assumptions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ul>
      </details>
      <p className="hint">
        Snapshot {result.snapshot.date}, file {result.snapshot.file}. Took {formatInt(result.elapsedMs)} ms.
      </p>
    </div>
  )
}

function Notes({ items }: { items: string[] }) {
  if (!items.length) return null
  return (
    <ul>
      {items.map((n, i) => (
        <li key={i}>{n}</li>
      ))}
    </ul>
  )
}

function NumberField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange(v: string): void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
    </div>
  )
}
