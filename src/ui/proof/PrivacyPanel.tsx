import { useCallback, useEffect, useId, useState } from 'react'
import { PRIVACY_LINE } from '../appState'
import { SECURITY_HEADERS, cspDirectives } from './policy'

interface Observed {
  name: string
  kind: string
}

function observedRequests(): Observed[] {
  const out: Observed[] = []
  for (const e of performance.getEntriesByType('navigation')) out.push({ name: e.name, kind: 'page load' })
  for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) out.push({ name: e.name, kind: e.initiatorType || 'resource' })
  return out
}

/** Privacy policy plus the list of requests this page has made, as the browser reports them. */
export function PrivacyPanel() {
  const ids = useId()
  const [entries, setEntries] = useState<Observed[]>(() => observedRequests())
  const refresh = useCallback(() => setEntries(observedRequests()), [])

  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return
    const observer = new PerformanceObserver(() => refresh())
    try {
      observer.observe({ type: 'resource', buffered: false })
    } catch {
      return
    }
    return () => observer.disconnect()
  }, [refresh])

  return (
    <section aria-labelledby={`${ids}-h`} data-testid="privacy-panel" className="prose">
      <h2 id={`${ids}-h`}>Privacy</h2>
      <p>
        <strong>{PRIVACY_LINE}</strong>
      </p>
      <ul>
        <li>Files are read in this browser tab by a background worker. Parsing, pricing, totals and exports all run here.</li>
        <li>Imported rows are stored in this browser's local database so the table can page through them. Clear local data on the Import page deletes them.</li>
        <li>The page fetches only its own files: the app code, the pricing snapshot and its manifest, and recorded benchmark results.</li>
        <li>
          The site sends a content security policy. Network requests may go only to its own origin. Workers may also start from local blob: URLs, and
          images may also come from inline data: URLs. Neither of those makes a network request.
        </li>
        <li>There are no analytics, no cookies and no third-party scripts.</li>
      </ul>

      <h3>Content security policy</h3>
      <p>These are the exact directives the site sends with every page.</p>
      <ul className="policy" data-testid="csp-directives">
        {cspDirectives().map((d) => (
          <li key={d}>
            <code>{d}</code>
          </li>
        ))}
      </ul>
      <h3>Other headers</h3>
      <ul className="policy" data-testid="security-headers">
        {SECURITY_HEADERS.filter((h) => h.key !== 'Content-Security-Policy').map((h) => (
          <li key={h.key}>
            <code>
              {h.key}: {h.value}
            </code>
          </li>
        ))}
      </ul>

      <h3>Requests this page has made</h3>
      <p>
        This list comes from the browser's own timing records for this page. It names each request. The page cannot read request sizes or request bodies, so it
        cannot show how many bytes were sent. Requests made before this panel opened are included.
      </p>
      <button type="button" onClick={refresh}>
        Refresh the list
      </button>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="Observed requests">
        <table className="data">
          <caption>{entries.length} requests observed</caption>
          <thead>
            <tr>
              <th scope="col">Request</th>
              <th scope="col">Type</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.name}-${i}`}>
                <td className="url">{e.name}</td>
                <td>{e.kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
