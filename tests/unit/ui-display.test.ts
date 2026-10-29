import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { AggregateBucket, AuditRow } from '../../src/engine/contracts'
import { COST_TOTALS_TERM, EXCLUDED_HEADING, PARTIAL_TOTAL, ROW_COUNTS_TERM, UNRESOLVED_VALUE, bucketIsPartial, bucketValue, excludedGroups, loggedValue, rowInclusion, rowValueText } from '../../src/ui/audit/display'
import { RowPageCache } from '../../src/ui/audit/rowPages'
import { loadFrozenSnapshot, sha256HexOf } from '../../src/ui/pricing'
import { TEST_META, TEST_SNAPSHOT, makeAuditRow } from './helpers/testSnapshot'
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, cspDirectives } from '../../src/ui/proof/policy'

function bucket(over: Partial<AggregateBucket>): AggregateBucket {
  return {
    key: 'openai',
    rows: 7,
    requests: 7,
    tokens: { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 },
    valueUsd: '0.0535932',
    rowsNotPriced: 0,
    rowsUnresolved: 0,
    partial: false,
    ...over,
  }
}

function cost(kind: AuditRow['cost']['label']['kind'], valueUsd: string | null): Pick<AuditRow, 'cost'> {
  return {
    cost: {
      valueUsd,
      label: { kind, reason: 'test' },
      estimateUsd: valueUsd,
      estimateLabel: { kind, reason: 'test' },
      appliedRates: [],
      formula: '',
    },
  }
}

const src = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('row value text', () => {
  it('an Unresolved row reads "Unresolved, review needed"', () => {
    expect(UNRESOLVED_VALUE).toBe('Unresolved, review needed')
    expect(rowValueText(cost('Unresolved', null))).toBe('Unresolved, review needed')
  })

  it('other rows show the amount, or no value', () => {
    expect(rowValueText(cost('Estimated', '0.005615'))).toBe('$0.005615')
    expect(rowValueText(cost('Measured charge', '0'))).toBe('$0.000000')
    expect(rowValueText(cost('Not priced', null))).toBe('no value')
  })

  it('the row table and the drawer both use it', () => {
    expect(src('src/ui/audit/RowTable.tsx')).toContain('rowValueText(row)')
    expect(src('src/ui/audit/RowDrawer.tsx')).toContain('rowValueText(row)')
  })
})

describe('breakdown values', () => {
  it('a bucket that leaves out Not priced or Unresolved rows is a partial total', () => {
    expect(PARTIAL_TOTAL).toBe('partial total')
    expect(bucketIsPartial(bucket({}))).toBe(false)
    expect(bucketIsPartial(bucket({ rowsNotPriced: 1 }))).toBe(true)
    expect(bucketIsPartial(bucket({ rowsUnresolved: 1 }))).toBe(true)
    expect(bucketValue(bucket({ rowsNotPriced: 1, rowsUnresolved: 1 }))).toEqual({ text: '$0.053593', partial: true })
  })

  it('uses the partial flag from the engine', () => {
    expect(bucketIsPartial(bucket({ partial: true }))).toBe(true)
    expect(bucketValue(bucket({ partial: true })).partial).toBe(true)
  })

  it('a bucket with no priced row shows no amount, not a zero', () => {
    expect(bucketValue(bucket({ rows: 2, valueUsd: null, rowsNotPriced: 1, rowsUnresolved: 1, partial: true }))).toEqual({ text: 'no value', partial: true })
    expect(bucketValue(bucket({ rows: 2, valueUsd: '0' }))).toEqual({ text: '$0.000000', partial: false })
  })

  it('the breakdown table marks partial values', () => {
    const panels = src('src/ui/audit/SummaryPanels.tsx')
    expect(panels).toContain('<BucketValueCell bucket={b} />')
    expect(panels).toContain('{PARTIAL_TOTAL}')
  })
})

describe('savings list price', () => {
  it('is a partial total when rows were left out of the comparison', () => {
    expect(loggedValue({ displayUsd: '$0.002250' }, [])).toEqual({ text: '$0.002250', partial: false })
    expect(loggedValue({ displayUsd: '$0.002250' }, [{ reason: 'Not priced', rows: 0 }])).toEqual({ text: '$0.002250', partial: false })
    expect(loggedValue({ displayUsd: '$0.002250' }, [{ reason: 'Not priced', rows: 2 }])).toEqual({ text: '$0.002250', partial: true })
  })

  it('the savings panel runs in the worker and shows the engine figures as they are', () => {
    const panel = src('src/ui/audit/SavingsPanel.tsx')
    expect(panel).toContain('client.scenario(')
    expect(panel).toContain('loadFrozenSnapshot(summary.snapshot, pricing)')
    expect(panel).not.toMatch(/createPricingEngine|createScenario|modelBaseline|modelRouting/)
    expect(panel).toContain('{result.routing.savings.displayUsd}')
    expect(panel).toContain('{result.baseline.difference.displayUsd}')
    expect(panel).toContain('{result.loggedVersusList.label}')
    expect(panel).toContain('{PARTIAL_TOTAL}')
    expect(panel).toContain('{ASSUMPTION_LABEL}')
  })

  it('the JSON report carries the same scenario result object', () => {
    const page = src('src/ui/audit/AuditPage.tsx')
    expect(page).toContain('buildReport(summary, identityInputs, new Date().toISOString(), savings.result ?? null)')
    expect(page).toContain('durationMap: savings.inputs.durationMap')
  })
})

describe('frozen snapshot for the savings model', () => {
  const bytes = new TextEncoder().encode(JSON.stringify(TEST_SNAPSHOT))
  const sha = sha256HexOf(bytes)
  const loaded = { snapshot: TEST_SNAPSHOT, meta: { ...TEST_META, sha256: sha } }

  it("uses the loaded snapshot when its SHA-256 is the audit's, without a fetch", async () => {
    const fetchImpl = vi.fn()
    await expect(loadFrozenSnapshot({ file: 'x.json', sha256: sha }, loaded, fetchImpl as unknown as typeof fetch)).resolves.toBe(TEST_SNAPSHOT)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("fetches the audit's own file when the loaded snapshot differs, and checks its SHA-256", async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return new Response(bytes)
    }) as unknown as typeof fetch
    const other = { ...loaded, meta: { ...loaded.meta, sha256: 'f'.repeat(64) } }
    const got = await loadFrozenSnapshot({ file: '2026-01-01-0123abcd.json', sha256: sha }, other, fetchImpl)
    expect(got).toEqual(TEST_SNAPSHOT)
    expect(urls).toEqual(['/pricing/2026-01-01-0123abcd.json'])
  })

  it('refuses a file whose bytes do not match the audit', async () => {
    const fetchImpl = (async () => new Response(bytes)) as unknown as typeof fetch
    await expect(loadFrozenSnapshot({ file: '2026-01-02-0123abcd.json', sha256: 'e'.repeat(64) }, null, fetchImpl)).rejects.toThrow(/does not match the audit/)
  })
})

describe('excluded from cost', () => {
  it('always lists audio, image, web search and tool calls under the exact heading', () => {
    expect(EXCLUDED_HEADING).toBe('Excluded from cost')
    expect(excludedGroups({})).toEqual([
      { label: 'Audio tokens', count: 0, keys: ['input_audio', 'output_audio'] },
      { label: 'Image tokens', count: 0, keys: ['input_image', 'output_image'] },
      { label: 'Web search requests', count: 0, keys: ['web_search_requests'] },
      { label: 'Tool calls', count: 0, keys: ['server_tool_calls', 'tool_calls', 'tool_sessions'] },
    ])
  })

  it('sums keys into groups and keeps unknown keys', () => {
    const groups = excludedGroups({ input_audio: 3, output_audio: 2, web_search_requests: 1, server_tool_calls: 4, input_video: 9, web_fetch_requests: 0, other_thing: 5 })
    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ['Audio tokens', 5],
      ['Image tokens', 0],
      ['Web search requests', 1],
      ['Tool calls', 4],
      ['Video tokens', 9],
      ['other_thing', 5],
    ])
  })

  it('the coverage panel and the drawer use the heading, and the old wording is gone', () => {
    const panels = src('src/ui/audit/SummaryPanels.tsx')
    const drawer = src('src/ui/audit/RowDrawer.tsx')
    expect(panels).toMatch(/export function CoveragePanel[\s\S]*<ExcludedList excluded=\{summary\.excludedFromCost\} \/>/)
    expect(panels).toContain('{EXCLUDED_HEADING}')
    expect(drawer).toContain('{EXCLUDED_HEADING}:')
    expect(panels + drawer).not.toContain('Counted but not priced')
  })
})

describe('privacy panel policy', () => {
  it('mirrors the headers in vercel.json exactly', () => {
    const vercel = JSON.parse(src('vercel.json')) as { headers: { source: string; headers: { key: string; value: string }[] }[] }
    expect(vercel.headers).toHaveLength(1)
    expect(SECURITY_HEADERS).toEqual(vercel.headers[0]!.headers)
    const csp = vercel.headers[0]!.headers.find((h) => h.key === 'Content-Security-Policy')
    expect(CONTENT_SECURITY_POLICY).toBe(csp?.value)
  })

  it('lists every directive', () => {
    expect(cspDirectives()).toEqual([
      "default-src 'self'",
      "connect-src 'self'",
      "script-src 'self'",
      "worker-src 'self' blob:",
      "img-src 'self' data:",
      "style-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ])
    const panel = src('src/ui/proof/PrivacyPanel.tsx')
    expect(panel).toContain('cspDirectives().map')
    expect(panel).not.toContain('only allows requests to its own origin')
  })
})

describe('row page cache', () => {
  type R = { rowIndex: number }
  const fetchPage = async (offset: number, limit: number): Promise<R[]> => Array.from({ length: limit }, (_, i) => ({ rowIndex: offset + i }))
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('keeps only pages near the visible rows while scrolling through a large audit', async () => {
    let changes = 0
    const cache = new RowPageCache<R>(fetchPage, () => changes++, 100, 2)
    let most = 0
    for (let first = 0; first < 380_000; first += 1_000) {
      cache.show(first, first + 40)
      await settle()
      most = Math.max(most, cache.size)
    }
    expect(most).toBeLessThanOrEqual(5)
    expect(cache.size).toBeLessThanOrEqual(5)
    expect(cache.rowAt(379_020)?.rowIndex).toBe(379_020)
    expect(cache.rowAt(0)).toBeUndefined()
    expect(changes).toBeGreaterThan(0)
  })

  it('fetches a dropped page again when it comes back into view', async () => {
    const calls: number[] = []
    const cache = new RowPageCache<R>(async (o, l) => {
      calls.push(o)
      return fetchPage(o, l)
    }, () => undefined, 100, 1)
    cache.show(0, 50)
    await settle()
    cache.show(5_000, 5_050)
    await settle()
    cache.show(0, 50)
    await settle()
    expect(calls).toEqual([0, 5_000, 0])
    expect(cache.rowAt(10)?.rowIndex).toBe(10)
  })

  it('does not keep a page that was dropped while it loaded', async () => {
    let release: (() => void) | null = null
    const cache = new RowPageCache<R>(
      (o, l) => (o === 0 ? new Promise<R[]>((r) => (release = () => r(Array.from({ length: l }, (_, i) => ({ rowIndex: o + i }))))) : fetchPage(o, l)),
      () => undefined,
      100,
      1,
    )
    cache.show(0, 50)
    cache.show(9_000, 9_050)
    release!()
    await settle()
    expect(cache.rowAt(0)).toBeUndefined()
    expect(cache.size).toBe(1)
  })
})

describe('row inclusion text', () => {
  it('an Unresolved row: row counts yes, cost totals no with the reason', () => {
    const r = rowInclusion(makeAuditRow({ kind: 'Unresolved' }))
    expect(r).toEqual({ rowCounts: true, costTotals: false, rowCountsText: 'yes', costTotalsText: 'no, Unresolved' })
  })

  it('a Not priced row: cost totals no, Not priced', () => {
    expect(rowInclusion(makeAuditRow({ kind: 'Not priced' })).costTotalsText).toBe('no, Not priced')
  })

  it('a valid zero row stays in the cost totals', () => {
    const r = rowInclusion(makeAuditRow({ value: '0' }))
    expect([r.rowCountsText, r.costTotalsText]).toEqual(['yes', 'yes'])
  })

  it('an aggregate span is in neither, kept only to reconcile other rows', () => {
    const r = rowInclusion(makeAuditRow({ counted: false, value: '0.5' }))
    expect(r).toEqual({
      rowCounts: false,
      costTotals: false,
      rowCountsText: 'no, kept only to reconcile other rows',
      costTotalsText: 'no, kept only to reconcile other rows',
    })
  })

  it('the drawer and the coverage panel use the same two terms', () => {
    expect(ROW_COUNTS_TERM).toBe('Included in row counts')
    expect(COST_TOTALS_TERM).toBe('Included in cost totals')
    const drawer = readFileSync('src/ui/audit/RowDrawer.tsx', 'utf8')
    expect(drawer).not.toContain('Counted in totals')
    expect(readFileSync('src/ui/audit/SummaryPanels.tsx', 'utf8')).toContain('Rows included in row counts')
  })
})
