import { useId, useMemo, useState } from 'react'
import type { AuditSummary, PricingSnapshot, RoutingAssumptions } from '../../engine/contracts'
import { ASSUMPTION_LABEL, BASELINE_LABEL, modelBaseline, modelRouting, type BaselineResult, type RoutingResult } from '../../engine/savings'

export interface SavingsState {
  baselineModel: string | null
  routing: RoutingAssumptions | null
  baseline: BaselineResult | null
  routingResult: RoutingResult | null
}

export const EMPTY_SAVINGS: SavingsState = { baselineModel: null, routing: null, baseline: null, routingResult: null }

interface Props {
  summary: AuditSummary
  snapshot: PricingSnapshot
  value: SavingsState
  onChange(s: SavingsState): void
}

const BANDS = ['<1k', '1k-10k', '10k-100k', '>=100k']
const DECIMAL = /^\d+(\.\d{1,6})?$/

interface Draft {
  sourceModels: string[]
  inputBands: string[]
  targetModel: string
  eligibleShare: string
  outputLengthRatio: string
  tokenizerRatio: string
  retryFallbackRate: string
  routingOverheadTokens: string
  calibrationPassRate: string
}

const initialDraft: Draft = {
  sourceModels: [],
  inputBands: [],
  targetModel: '',
  eligibleShare: '0.5',
  outputLengthRatio: '1',
  tokenizerRatio: '1',
  retryFallbackRate: '0',
  routingOverheadTokens: '0',
  calibrationPassRate: '',
}

function draftToAssumptions(d: Draft): { value: RoutingAssumptions | null; error: string | null } {
  if (!d.targetModel.trim()) return { value: null, error: 'Choose a target model.' }
  const decimals: [keyof Draft, string][] = [
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
  return {
    error: null,
    value: {
      sourceModels: d.sourceModels,
      inputBands: d.inputBands,
      targetModel: d.targetModel.trim(),
      eligibleShare: d.eligibleShare.trim(),
      outputLengthRatio: d.outputLengthRatio.trim(),
      tokenizerRatio: d.tokenizerRatio.trim(),
      retryFallbackRate: d.retryFallbackRate.trim(),
      routingOverheadTokens: Number(d.routingOverheadTokens.trim()),
      calibrationPassRate: pass || null,
    },
  }
}

/** What-if modelling over logged token sums. Every result is Estimated and quality is unverified. */
export function SavingsPanel({ summary, snapshot, value, onChange }: Props) {
  const ids = useId()
  const modelKeys = useMemo(() => Object.keys(snapshot.models).sort(), [snapshot])
  const sourceModels = useMemo(() => [...new Set(summary.bands.map((b) => b.model))].sort(), [summary])
  const [baselineInput, setBaselineInput] = useState(value.baselineModel ?? '')
  const [baselineError, setBaselineError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(initialDraft)
  const [routingError, setRoutingError] = useState<string | null>(null)

  const runBaseline = () => {
    const key = baselineInput.trim()
    if (!key) return setBaselineError('Choose a baseline model.')
    try {
      const baseline = modelBaseline(summary.bands, snapshot, key)
      setBaselineError(null)
      onChange({ ...value, baselineModel: key, baseline })
    } catch (err) {
      setBaselineError(err instanceof Error ? err.message : String(err))
    }
  }

  const runRouting = () => {
    const { value: assumptions, error } = draftToAssumptions(draft)
    if (!assumptions) return setRoutingError(error)
    try {
      const routingResult = modelRouting(summary.bands, snapshot, assumptions)
      setRoutingError(null)
      onChange({ ...value, routing: assumptions, routingResult })
    } catch (err) {
      setRoutingError(err instanceof Error ? err.message : String(err))
    }
  }

  const toggle = (list: string[], item: string) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item])
  const setField = (k: keyof Draft, v: string) => setDraft((d) => ({ ...d, [k]: v }))

  return (
    <section className="panel" data-testid="savings-panel" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Savings modeller</h2>
      <p>
        These are what-if numbers: logged token sums repriced at snapshot list prices. Every result is Estimated. Quality on another model is unverified.
      </p>
      <datalist id={`${ids}-models`}>
        {modelKeys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>

      <h3>Baseline</h3>
      <div className="field inline">
        <label htmlFor={`${ids}-base`}>Baseline model</label>
        <input id={`${ids}-base`} list={`${ids}-models`} value={baselineInput} onChange={(e) => setBaselineInput(e.target.value)} autoComplete="off" spellCheck={false} />
        <button type="button" onClick={runBaseline}>
          Model the baseline
        </button>
      </div>
      {baselineError && <p className="notice error" role="alert">{baselineError}</p>}
      {value.baseline && (
        <div className="result" role="status">
          <p className="badge-line">
            <span className="badge" data-kind="Estimated">Estimated</span> {value.baseline.label.reason}. Quality: {value.baseline.quality}.
          </p>
          <dl className="stats">
            <div>
              <dt>Logged value of repriced rows</dt>
              <dd>{value.baseline.actual.displayUsd}</dd>
            </div>
            <div>
              <dt>{BASELINE_LABEL}</dt>
              <dd>{value.baseline.baseline.displayUsd}</dd>
            </div>
            <div>
              <dt>Baseline minus logged</dt>
              <dd>{value.baseline.difference.displayUsd}</dd>
            </div>
          </dl>
          <Assumptions items={value.baseline.assumptions} skipped={value.baseline.skipped.length} />
        </div>
      )}

      <h3>Routing scenario</h3>
      <fieldset>
        <legend>Source models (none ticked means all)</legend>
        <div className="checks">
          {sourceModels.map((m) => (
            <label key={m} className="check">
              <input type="checkbox" checked={draft.sourceModels.includes(m)} onChange={() => setDraft((d) => ({ ...d, sourceModels: toggle(d.sourceModels, m) }))} />
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
          <label htmlFor={`${ids}-target`}>Target model</label>
          <input id={`${ids}-target`} list={`${ids}-models`} value={draft.targetModel} onChange={(e) => setField('targetModel', e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <NumberField id={`${ids}-share`} label="Eligible share (0 to 1)" value={draft.eligibleShare} onChange={(v) => setField('eligibleShare', v)} />
        <NumberField id={`${ids}-out`} label="Output length ratio" value={draft.outputLengthRatio} onChange={(v) => setField('outputLengthRatio', v)} />
        <NumberField id={`${ids}-tok`} label="Tokenizer ratio" value={draft.tokenizerRatio} onChange={(v) => setField('tokenizerRatio', v)} />
        <NumberField id={`${ids}-retry`} label="Retry and fallback rate" value={draft.retryFallbackRate} onChange={(v) => setField('retryFallbackRate', v)} />
        <NumberField id={`${ids}-over`} label="Routing overhead tokens per request" value={draft.routingOverheadTokens} onChange={(v) => setField('routingOverheadTokens', v)} />
        <NumberField id={`${ids}-pass`} label="Calibration pass rate (optional)" value={draft.calibrationPassRate} onChange={(v) => setField('calibrationPassRate', v)} />
      </div>
      <p className="hint">Each value above is a {ASSUMPTION_LABEL}.</p>
      <button type="button" onClick={runRouting}>
        Model the routing scenario
      </button>
      {routingError && <p className="notice error" role="alert">{routingError}</p>}
      {value.routingResult && (
        <div className="result" role="status">
          <p className="badge-line">
            <span className="badge" data-kind="Estimated">Estimated</span> {value.routingResult.label.reason}. Quality: {value.routingResult.quality}.
          </p>
          <dl className="stats">
            <div>
              <dt>Logged value of priced rows</dt>
              <dd>{value.routingResult.original.displayUsd}</dd>
            </div>
            <div>
              <dt>Scenario value</dt>
              <dd>{value.routingResult.scenario.displayUsd}</dd>
            </div>
            <div>
              <dt>Savings (negative means the scenario costs more)</dt>
              <dd>{value.routingResult.savings.displayUsd}</dd>
            </div>
          </dl>
          <p>
            {value.routingResult.bandsEligible} of {value.routingResult.bandsUsed} priced groups matched the scenario.
          </p>
          <Assumptions items={value.routingResult.assumptions} skipped={value.routingResult.skipped.length} />
        </div>
      )}
    </section>
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

function Assumptions({ items, skipped }: { items: string[]; skipped: number }) {
  return (
    <details>
      <summary>Assumptions{skipped ? ` and ${skipped} groups left out` : ''}</summary>
      <ul>
        {items.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
        {skipped > 0 && <li>{skipped} groups have rows that are Not priced or Unresolved and are left out.</li>}
      </ul>
    </details>
  )
}
