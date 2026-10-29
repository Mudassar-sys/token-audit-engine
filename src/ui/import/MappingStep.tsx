import { useEffect, useId, useState } from 'react'
import { CacheDuration, type CustomCsvMapping, type NormalizedUsageRow } from '../../engine/contracts'
import type { EngineClient } from '../engineClient'
import { formatInt, sumCacheWrite } from '../format'

type ColumnField = Exclude<keyof CustomCsvMapping, 'inputIncludesCached' | 'cacheWriteDuration'>

const TOK = '(_tok(en)?s?)?'
const FIELDS: { key: ColumnField; label: string; hints: RegExp }[] = [
  { key: 'timestamp', label: 'Timestamp', hints: /^(timestamp|time|date|created(_at)?|start_?time|event_time|ts)$/i },
  { key: 'provider', label: 'Provider', hints: /^(provider|vendor|custom_llm_provider)$/i },
  { key: 'model', label: 'Model', hints: /^(model|model_name|model_id)$/i },
  { key: 'inputTokens', label: 'Input tokens', hints: new RegExp(`^((input|prompt)${TOK}|tokens_in)$`, 'i') },
  { key: 'cacheRead', label: 'Cache read tokens', hints: new RegExp(`^(cache_?read|cached)(_input)?${TOK}$`, 'i') },
  { key: 'cacheWrite', label: 'Cache write tokens', hints: new RegExp(`^(cache_?write|cache_creation)(_input)?${TOK}$`, 'i') },
  { key: 'outputTokens', label: 'Output tokens', hints: new RegExp(`^((output|completion)${TOK}|tokens_out)$`, 'i') },
  { key: 'reasoningTokens', label: 'Reasoning tokens', hints: new RegExp(`^(reasoning|thinking)${TOK}$`, 'i') },
  { key: 'tier', label: 'Tier', hints: /^(tier|service_tier|service_level)$/i },
  { key: 'reportedCharge', label: 'Billed charge (USD)', hints: /^(cost|charge|billed|amount)(_usd)?$|^usd_cost$/i },
]

const STORAGE_PREFIX = 'token-audit:mapping:'
/** Wait this long after a change before mapping the preview rows. */
const PREVIEW_DELAY_MS = 150

function storageKey(headers: readonly string[]): string {
  return STORAGE_PREFIX + JSON.stringify(headers)
}

export function loadSavedMapping(headers: readonly string[]): CustomCsvMapping | null {
  try {
    const raw = localStorage.getItem(storageKey(headers))
    return raw ? (JSON.parse(raw) as CustomCsvMapping) : null
  } catch {
    return null
  }
}

/** A starting mapping guessed from header names. The user confirms every choice. */
export function guessMapping(headers: readonly string[]): CustomCsvMapping {
  const pick = (re: RegExp) => headers.find((h) => re.test(h.trim())) ?? null
  const m: CustomCsvMapping = {
    timestamp: null,
    provider: null,
    model: null,
    inputTokens: null,
    inputIncludesCached: true,
    cacheRead: null,
    cacheWrite: null,
    cacheWriteDuration: null,
    outputTokens: null,
    reasoningTokens: null,
    tier: null,
    reportedCharge: null,
  }
  for (const f of FIELDS) m[f.key] = pick(f.hints)
  return m
}

export function mappingProblem(m: CustomCsvMapping | null): string | null {
  if (!m) return 'Choose the columns first.'
  if (!m.model) return 'Choose the model column.'
  if (!m.inputTokens && !m.outputTokens) return 'Choose at least the input or the output token column.'
  return null
}

interface Props {
  client: EngineClient
  file: File
  headers: readonly string[]
  mapping: CustomCsvMapping | null
  onChange(m: CustomCsvMapping): void
}

/** Column mapping for a custom CSV (variant H), with a preview of the first 20 mapped rows. */
export function MappingStep({ client, file, headers, mapping, onChange }: Props) {
  const ids = useId()
  const [preview, setPreview] = useState<{ rows: NormalizedUsageRow[]; errors: string[] } | null>(null)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!mapping) onChange(loadSavedMapping(headers) ?? guessMapping(headers))
  }, [mapping, headers, onChange])

  // The preview follows every change to a usable mapping. Stale answers are dropped.
  useEffect(() => {
    if (!mapping || mappingProblem(mapping) !== null) return
    let stale = false
    const timer = setTimeout(() => {
      setStatus('Mapping the first rows.')
      client.preview(file, mapping).then(
        (res) => {
          if (stale) return
          setPreview(res)
          setStatus(`Preview shows ${res.rows.length} mapped rows${res.errors.length ? ` and ${res.errors.length} problems` : ''}.`)
        },
        (err: unknown) => {
          if (!stale) setStatus(`Preview failed: ${err instanceof Error ? err.message : String(err)}`)
        },
      )
    }, PREVIEW_DELAY_MS)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [client, file, mapping])

  if (!mapping) return null
  const set = (p: Partial<CustomCsvMapping>) => {
    setPreview(null)
    onChange({ ...mapping, ...p })
  }
  const problem = mappingProblem(mapping)

  const save = () => {
    try {
      localStorage.setItem(storageKey(headers), JSON.stringify(mapping))
      setStatus('Mapping saved in this browser for files with the same header row.')
    } catch {
      setStatus('This browser refused to save the mapping.')
    }
  }

  return (
    <section className="panel" data-testid="mapping-panel" aria-labelledby={`${ids}-h`}>
      <h2 id={`${ids}-h`}>Map the CSV columns</h2>
      <p>This CSV does not match a known log format. Tell the engine which column holds each value. Columns left as "Not in file" are labelled Not measured.</p>
      <div className="mapping-grid">
        {FIELDS.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`${ids}-${f.key}`}>{f.label}</label>
            <select id={`${ids}-${f.key}`} data-testid={`map-${f.key}`} value={mapping[f.key] ?? ''} onChange={(e) => set({ [f.key]: e.target.value || null })}>
              <option value="">Not in file</option>
              {headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </div>
        ))}
        <div className="field">
          <label htmlFor={`${ids}-dur`}>Cache write duration</label>
          <select
            id={`${ids}-dur`}
            data-testid="map-cacheWriteDuration"
            value={mapping.cacheWriteDuration ?? ''}
            onChange={(e) => set({ cacheWriteDuration: e.target.value ? CacheDuration.parse(e.target.value) : null })}
          >
            <option value="">Not stated (5m assumed)</option>
            <option value="5m">5 minutes</option>
            <option value="1h">1 hour</option>
            <option value="30m">30 minutes</option>
            <option value="12h">12 hours</option>
          </select>
        </div>
        <div className="field checkbox">
          <input
            id={`${ids}-incl`}
            data-testid="map-inputIncludesCached"
            type="checkbox"
            checked={mapping.inputIncludesCached}
            onChange={(e) => set({ inputIncludesCached: e.target.checked })}
          />
          <label htmlFor={`${ids}-incl`}>Input includes cached tokens</label>
        </div>
      </div>
      {problem && <p className="hint">{problem}</p>}
      <div className="actions">
        <button type="button" data-testid="save-mapping" onClick={save}>
          Save mapping
        </button>
      </div>
      <p role="status" className="status-line">{status}</p>
      {preview && (
        <div className="table-scroll" data-testid="mapping-preview" tabIndex={0} role="region" aria-label="Mapped rows preview">
          <table className="data">
            <caption>First {preview.rows.length} mapped rows</caption>
            <thead>
              <tr>
                <th scope="col">Row</th>
                <th scope="col">Model</th>
                <th scope="col">Uncached input</th>
                <th scope="col">Cache read</th>
                <th scope="col">Cache write</th>
                <th scope="col">Output</th>
                <th scope="col">Not measured</th>
                <th scope="col">Problem</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.rowIndex}>
                  <td>{r.rowIndex + 1}</td>
                  <td>{r.modelLogged ?? 'no model'}</td>
                  <td className="num">{formatInt(r.tokens.uncachedInput)}</td>
                  <td className="num">{formatInt(r.tokens.cacheRead)}</td>
                  <td className="num">{formatInt(sumCacheWrite(r.tokens.cacheWrite))}</td>
                  <td className="num">{formatInt(r.tokens.output)}</td>
                  <td>{r.notMeasured.join(', ') || 'none'}</td>
                  <td>{r.unresolvedReason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.errors.length > 0 && (
            <ul className="errors">
              {preview.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
