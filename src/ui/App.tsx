import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getEngineClient } from './engineClient'
import { PRIVACY_LINE, SAMPLE_BYTES, effectiveVariant, errorText, initialImport, type ImportState, type OpenAudit } from './appState'
import { loadPricing, type LoadedPricing } from './pricing'
import { routeHref, useHashRoute, type Route } from './useHashRoute'
import { ImportPage } from './import/ImportPage'
import { AuditPage } from './audit/AuditPage'
import { ProofPage } from './proof/ProofPage'

const SAMPLE_SEED = 7

export function App() {
  const client = useMemo(() => getEngineClient(), [])
  const [route, navigate] = useHashRoute()
  const [pricing, setPricing] = useState<LoadedPricing | null>(null)
  const [pricingError, setPricingError] = useState<string | null>(null)
  const [imp, setImp] = useState<ImportState>(initialImport)
  const [audit, setAudit] = useState<OpenAudit | null>(null)
  const [benchmarkRunning, setBenchmarkRunning] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const firstRoute = useRef(true)

  const fetchPricing = useCallback(() => {
    loadPricing().then(
      (p) => {
        setPricing(p)
        setPricingError(null)
      },
      (err: unknown) => setPricingError(errorText(err)),
    )
  }, [])
  useEffect(fetchPricing, [fetchPricing])
  const retryPricing = useCallback(() => {
    setPricingError(null)
    fetchPricing()
  }, [fetchPricing])

  // Move focus to the main region on route change so keyboard and screen reader users land on the new page.
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false
      return
    }
    mainRef.current?.focus()
  }, [route])

  const patch = useCallback((p: Partial<ImportState>) => setImp((s) => ({ ...s, ...p })), [])

  const chooseFile = useCallback(
    async (file: File | null) => {
      setImp((s) => ({ ...initialImport, phase: s.phase, file, detecting: file !== null }))
      if (!file) return
      try {
        const detection = await client.detect(file)
        setImp((s) => (s.file === file ? { ...s, detection, detecting: false } : s))
      } catch (err) {
        setImp((s) => (s.file === file ? { ...s, detecting: false, notice: { kind: 'error', text: `Detection failed: ${errorText(err)}` } } : s))
      }
    },
    [client],
  )

  const generateSample = useCallback(async () => {
    patch({ sampleBytes: 0, notice: null })
    try {
      const sample = await client.generateSample(SAMPLE_BYTES, SAMPLE_SEED, (b) => patch({ sampleBytes: b }))
      patch({ sampleBytes: null })
      const file = sample.file instanceof File ? sample.file : new File([sample.file], 'sample-litellm-spend-200mb.csv', { type: 'text/csv' })
      await chooseFile(file)
      patch({ notice: { kind: 'info', text: `Sample ready: ${sample.rows.toLocaleString('en-US')} rows, ${sample.columns} columns.` } })
    } catch (err) {
      patch({ sampleBytes: null, notice: { kind: 'error', text: `Sample generation failed: ${errorText(err)}` } })
    }
  }, [client, chooseFile, patch])

  const startImport = useCallback(async () => {
    const variant = effectiveVariant(imp)
    if (!imp.file || !imp.detection || !variant || !pricing) return
    const usedPricing = pricing
    setAudit(null)
    patch({ phase: 'running', progress: null, notice: null })
    try {
      const outcome = await client.importFile(
        {
          file: imp.file,
          fileName: imp.file.name,
          variant,
          detection: imp.detection,
          overridden: imp.override !== null && imp.override !== imp.detection.variant,
          mapping: variant === 'H-csv' ? imp.mapping : null,
          snapshot: usedPricing.snapshot,
          snapshotMeta: usedPricing.meta,
        },
        (progress) => patch({ progress }),
      )
      if (outcome.kind === 'done') {
        setAudit({ summary: outcome.summary, pricing: usedPricing })
        patch({ phase: 'idle', notice: null })
        navigate({ area: 'audit' })
      } else {
        patch({
          phase: 'idle',
          progress: null,
          notice: { kind: 'info', text: `Import stopped ${Math.round(outcome.cancelMs)} ms after cancel. ${outcome.partialRowsDeleted ? `Partial rows were deleted in ${Math.round(outcome.deleteMs)} ms.` : 'Partial rows could not be deleted. Use Clear local data.'}` },
        })
      }
    } catch (err) {
      patch({ phase: 'idle', notice: { kind: 'error', text: errorText(err) } })
    }
  }, [client, imp, pricing, patch, navigate])

  const cancelImport = useCallback(async () => {
    patch({ phase: 'cancelling' })
    try {
      await client.cancel()
    } catch (err) {
      patch({ notice: { kind: 'error', text: errorText(err) } })
    }
  }, [client, patch])

  const clearLocalData = useCallback(async () => {
    try {
      await client.clear()
      try {
        for (const key of Object.keys(localStorage)) if (key.startsWith('token-audit:')) localStorage.removeItem(key)
      } catch {
        // Storage not available.
      }
      setAudit(null)
      setImp(() => ({ ...initialImport, notice: { kind: 'info', text: 'Local data cleared. Stored rows, saved mappings and saved benchmark results were deleted.' } }))
    } catch (err) {
      patch({ notice: { kind: 'error', text: errorText(err) } })
    }
  }, [client, patch])

  const onBenchmarkStart = useCallback(() => {
    setBenchmarkRunning(true)
    setAudit(null)
  }, [])
  const onBenchmarkEnd = useCallback(() => setBenchmarkRunning(false), [])

  return (
    <>
      <a className="skip-link" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus() }}>
        Skip to content
      </a>
      <header className="site-header">
        <div className="wrap">
          <p className="site-title">Token Audit Engine</p>
          <p className="site-subtitle">Built as a working demonstration for a token-cost audit requirement.</p>
          <nav aria-label="Main">
            <ul className="nav">
              <NavItem route={route} target={{ area: 'import' }} label="Import" />
              <NavItem route={route} target={{ area: 'audit' }} label="Audit" />
              <NavItem route={route} target={{ area: 'proof', page: 'benchmark' }} label="Proof" />
            </ul>
          </nav>
        </div>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="wrap">
        {pricingError && (
          <div className="notice error" role="alert">
            <p>The pricing snapshot could not be loaded: {pricingError}</p>
            <button type="button" onClick={retryPricing}>Try again</button>
          </div>
        )}
        {route.area === 'import' && (
          <ImportPage
            client={client}
            state={imp}
            pricing={pricing}
            busy={benchmarkRunning}
            onChooseFile={chooseFile}
            onPatch={patch}
            onGenerateSample={generateSample}
            onImport={startImport}
            onCancel={cancelImport}
            onClear={clearLocalData}
          />
        )}
        {route.area === 'audit' && <AuditPage client={client} audit={audit} />}
        {route.area === 'proof' && (
          <ProofPage
            page={route.page}
            client={client}
            pricing={pricing}
            importBusy={imp.phase !== 'idle'}
            onBenchmarkStart={onBenchmarkStart}
            onBenchmarkEnd={onBenchmarkEnd}
          />
        )}
      </main>
      <footer className="site-footer">
        <div className="wrap">
          <p>{PRIVACY_LINE}</p>
          <p>
            Everything runs in this browser tab. See the <a href={routeHref({ area: 'proof', page: 'privacy' })}>privacy panel</a>.
          </p>
        </div>
      </footer>
    </>
  )
}

function NavItem({ route, target, label }: { route: Route; target: Route; label: string }) {
  const current = route.area === target.area
  return (
    <li>
      <a href={routeHref(target)} aria-current={current ? 'page' : undefined}>
        {label}
      </a>
    </li>
  )
}
