import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuditRow } from '../../src/engine/contracts'
import {
  StoreQuotaError,
  clearAll,
  countRows,
  deleteAudit,
  getAudit,
  getRow,
  getRows,
  isQuotaError,
  iterateRows,
  listAuditIds,
  mapStoreError,
  openStore,
  putAudit,
  putRows,
} from '../../src/worker/store'

function row(rowIndex: number, model = 'gpt-4o'): AuditRow {
  return {
    rowIndex,
    timestamp: '2026-10-01T00:00:00.000Z',
    variant: 'A-json',
    provider: 'openai',
    modelLogged: model,
    tierStated: null,
    granularity: 'request',
    tokens: { uncachedInput: 86, cacheRead: 1920, cacheWrite: { '5m': 0, '1h': 0, '30m': 0, '12h': 0 }, output: 300, reasoning: null },
    notMeasured: [],
    excluded: {},
    reported: null,
    raw: { 'usage.prompt_tokens': 2006 },
    mapping: ['uncachedInput = usage.prompt_tokens - cached_tokens'],
    flags: ['tier_assumed'],
    unresolvedReason: null,
    counted: true,
    requests: 1,
    resolvedKey: model,
    match: { kind: 'exact', detail: 'exact key', source: null },
    tierApplied: 'standard',
    cost: {
      valueUsd: '0.005615',
      label: { kind: 'Estimated', reason: 'tokens times snapshot rate' },
      estimateUsd: '0.005615',
      estimateLabel: { kind: 'Estimated', reason: 'tokens times snapshot rate' },
      appliedRates: [],
      formula: '',
    },
    labels: {},
    snapshot: { file: 'x.json', date: '2026-10-29', sha256: 'a'.repeat(64), commit: 'b'.repeat(40) },
  }
}

function rows(from: number, n: number): AuditRow[] {
  return Array.from({ length: n }, (_, i) => row(from + i))
}

afterEach(async () => {
  vi.restoreAllMocks()
  await clearAll()
})

describe('store', () => {
  it('stores and reads rows back in order without the audit id', async () => {
    await putRows('audit-1', rows(0, 250))
    await putRows('audit-1', rows(250, 250))
    expect(await countRows('audit-1')).toBe(500)
    const page = await getRows('audit-1', 100, 50)
    expect(page.map((r) => r.rowIndex)).toEqual(Array.from({ length: 50 }, (_, i) => 100 + i))
    expect(page[0]).toEqual(row(100))
    expect('auditId' in page[0]!).toBe(false)
    expect(await getRows('audit-1', 490, 50)).toHaveLength(10)
    expect(await getRows('audit-1', 600, 50)).toEqual([])
    expect(await getRows('audit-1', 0, 0)).toEqual([])
  })

  it('keeps audits apart', async () => {
    await putRows('audit-a', rows(0, 10))
    await putRows('audit-b', [row(0, 'claude-sonnet-4-5'), row(1, 'claude-sonnet-4-5')])
    expect((await getRows('audit-a', 0, 100)).length).toBe(10)
    const b = await getRows('audit-b', 0, 100)
    expect(b.map((r) => r.modelLogged)).toEqual(['claude-sonnet-4-5', 'claude-sonnet-4-5'])
  })

  it('gets one row by index', async () => {
    await putRows('audit-1', rows(0, 5))
    expect((await getRow('audit-1', 3))?.rowIndex).toBe(3)
    expect(await getRow('audit-1', 9)).toBeNull()
    expect(await getRow('other', 0)).toBeNull()
  })

  it('iterates every row in batches', async () => {
    await putRows('audit-1', rows(0, 1234))
    await putRows('audit-2', rows(0, 7))
    const sizes: number[] = []
    const seen: number[] = []
    const total = await iterateRows('audit-1', 500, async (batch) => {
      sizes.push(batch.length)
      seen.push(...batch.map((r) => r.rowIndex))
    })
    expect(total).toBe(1234)
    expect(sizes).toEqual([500, 500, 234])
    expect(seen).toEqual(Array.from({ length: 1234 }, (_, i) => i))
  })

  it('deletes one audit with its rows and keeps others', async () => {
    await putRows('audit-1', rows(0, 300))
    await putRows('audit-2', rows(0, 3))
    await putAudit({ auditId: 'audit-1', status: 'importing', fileName: 'a.json', startedAt: '2026-10-29T00:00:00.000Z', summary: null })
    await putAudit({ auditId: 'audit-2', status: 'importing', fileName: 'b.json', startedAt: '2026-10-29T00:00:00.000Z', summary: null })
    expect((await listAuditIds()).sort()).toEqual(['audit-1', 'audit-2'])
    await deleteAudit('audit-1')
    expect(await countRows('audit-1')).toBe(0)
    expect(await getRows('audit-1', 0, 10)).toEqual([])
    expect(await getAudit('audit-1')).toBeNull()
    expect(await countRows('audit-2')).toBe(3)
    expect((await getAudit('audit-2'))?.fileName).toBe('b.json')
  })

  it('clearAll deletes the database and the store opens again afterwards', async () => {
    await putRows('audit-1', rows(0, 3))
    await clearAll()
    expect(await countRows('audit-1')).toBe(0)
    await putRows('audit-1', rows(0, 1))
    expect(await countRows('audit-1')).toBe(1)
  })

  it('maps a quota error from a write to StoreQuotaError and stores nothing from that batch', async () => {
    await openStore()
    const proto = (globalThis as unknown as { IDBObjectStore: { prototype: { put: (...a: unknown[]) => unknown } } }).IDBObjectStore.prototype
    const original = proto.put
    let calls = 0
    vi.spyOn(proto, 'put').mockImplementation(function (this: unknown, ...args: unknown[]) {
      calls++
      if (calls === 3) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      return original.apply(this, args)
    })
    const err = await putRows('audit-q', rows(0, 5)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StoreQuotaError)
    expect((err as StoreQuotaError).code).toBe('quota')
    expect((err as Error).message).toMatch(/Local storage is full/)
    vi.restoreAllMocks()
    // The transaction was aborted, so no partial batch remains.
    expect(await countRows('audit-q')).toBe(0)
  })

  it('recognizes quota errors by name, including wrapped ones', () => {
    const q = new DOMException('full', 'QuotaExceededError')
    expect(isQuotaError(q)).toBe(true)
    expect(isQuotaError({ name: 'AbortError', error: q })).toBe(true)
    expect(isQuotaError(new Error('wrapped', { cause: q }))).toBe(true)
    expect(isQuotaError(new DOMException('aborted', 'AbortError'))).toBe(false)
    expect(isQuotaError(null)).toBe(false)
    expect(mapStoreError(q)).toBeInstanceOf(StoreQuotaError)
    const other = new Error('other')
    expect(mapStoreError(other)).toBe(other)
  })
})
