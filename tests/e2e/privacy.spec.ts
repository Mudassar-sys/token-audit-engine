import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Request } from '@playwright/test'
import { FIXTURES, MARKERS, autoFixtures, importFixture } from './helpers'

/** Requests the app is allowed to make: its own assets, the pricing snapshot and manifest, recorded benchmarks. */
function isAllowed(url: URL, origin: string): boolean {
  if (url.origin !== origin) return false
  const p = url.pathname
  return (
    p === '/' ||
    p === '/index.html' ||
    /^\/assets\/[\w.-]+\.(js|css|mjs)$/.test(p) ||
    p === '/pricing/manifest.json' ||
    /^\/pricing\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}(-\d+)?\.json$/.test(p) ||
    p === '/benchmarks/results.json'
  )
}

test('only allowlisted requests, and no file content leaves the page', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin
  const seen: Request[] = []
  const blocked: string[] = []
  await context.route('**/*', async (route) => {
    const req = route.request()
    seen.push(req)
    const url = new URL(req.url())
    if (url.protocol === 'blob:' || url.protocol === 'data:') return route.continue()
    if (!isAllowed(url, origin)) {
      blocked.push(`${req.method()} ${req.url()}`)
      return route.abort()
    }
    return route.continue()
  })

  const files = autoFixtures()
  const derived: string[] = []
  for (const file of files) {
    await importFixture(page, file)
    derived.push(file)
    const totals = (await page.getByTestId('totals').innerText()).match(/\$[\d,]+\.\d+/g) ?? []
    derived.push(...totals.filter((t) => t !== '$0.000000'))
    // Exports run locally too.
    const csv = page.waitForEvent('download')
    await page.getByTestId('export-csv').click()
    await csv
    const json = page.waitForEvent('download')
    await page.getByTestId('export-json').click()
    await json
  }

  expect(blocked, 'requests outside the allowlist').toEqual([])
  const needles = [...Object.values(MARKERS), ...new Set(derived)]
  expect(Object.keys(MARKERS).length).toBeGreaterThanOrEqual(files.length)
  for (const req of seen) {
    const haystack = [req.url(), JSON.stringify(await req.allHeaders()), req.postData() ?? ''].join('\n')
    for (const needle of needles) {
      expect(haystack.includes(needle), `${needle} found in ${req.url()}`).toBe(false)
    }
    expect(req.method()).toBe('GET')
  }
})

test('every fixture carries its marker', () => {
  for (const [file, marker] of Object.entries(MARKERS)) {
    expect(readFileSync(join(FIXTURES, file), 'utf8')).toContain(marker)
  }
})

test('a deliberate cross-origin request is blocked by the policy', async ({ page }) => {
  let reached = false
  await page.route('https://example.com/**', (route) => {
    reached = true
    return route.abort()
  })
  await page.goto('/#/import')
  const result = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener('securitypolicyviolation', (e) => resolve(e.effectiveDirective), { once: true })
      setTimeout(() => resolve('none'), 3000)
    })
    let outcome = 'sent'
    try {
      await fetch('https://example.com/collect', { method: 'POST', body: 'probe' })
    } catch {
      outcome = 'blocked'
    }
    return { outcome, directive: await violation }
  })
  expect(result.outcome).toBe('blocked')
  expect(result.directive).toBe('connect-src')
  expect(reached).toBe(false)
})

test('response headers carry the policy, noindex and isolation', async ({ request }) => {
  const res = await request.get('/')
  const h = res.headers()
  expect(h['content-security-policy']).toContain("default-src 'self'")
  expect(h['content-security-policy']).toContain("connect-src 'self'")
  expect(h['content-security-policy']).toContain("script-src 'self'")
  expect(h['content-security-policy']).toContain("worker-src 'self' blob:")
  expect(h['content-security-policy']).toContain("style-src 'self'")
  expect(h['content-security-policy']).toContain("object-src 'none'")
  expect(h['content-security-policy']).toContain("base-uri 'none'")
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'")
  expect(h['x-robots-tag']).toBe('noindex')
  expect(h['referrer-policy']).toBe('no-referrer')
  expect(h['cross-origin-opener-policy']).toBe('same-origin')
  expect(h['cross-origin-embedder-policy']).toBe('require-corp')
})
