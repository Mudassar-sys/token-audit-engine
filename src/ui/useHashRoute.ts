import { useCallback, useEffect, useState } from 'react'

export type Route =
  | { area: 'import' }
  | { area: 'audit' }
  | { area: 'proof'; page: 'benchmark' | 'methodology' | 'privacy' }

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'audit') return { area: 'audit' }
  if (parts[0] === 'proof') {
    const page = parts[1]
    if (page === 'methodology' || page === 'privacy') return { area: 'proof', page }
    return { area: 'proof', page: 'benchmark' }
  }
  return { area: 'import' }
}

export function routeHref(route: Route): string {
  return route.area === 'proof' ? `#/proof/${route.page}` : `#/${route.area}`
}

/** Hash routing. Navigation never makes a network request. */
export function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const navigate = useCallback((r: Route) => {
    const href = routeHref(r)
    if (window.location.hash !== href) window.location.hash = href
    else setRoute(r)
  }, [])
  return [route, navigate]
}
