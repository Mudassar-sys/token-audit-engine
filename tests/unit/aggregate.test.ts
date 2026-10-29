import { describe, expect, it } from 'vitest'
import { Aggregator, inputBand, OVERFLOW_KEY } from '../../src/engine/aggregate'
import { AuditSummary } from '../../src/engine/contracts'
import { makeAuditRow } from './helpers/testSnapshot'

describe('Aggregator', () => {
  it('caps each dimension and folds new keys into (overflow)', () => {
    const agg = new Aggregator(3)
    const models = ['m1', 'm2', 'm3', 'm4', 'm5', 'm4']
    models.forEach((m, i) => agg.add(makeAuditRow({ rowIndex: i, model: m, value: '0.01' })))
    const s = agg.summary()
    expect(s.aggregates.byModel.map((b) => b.key).sort()).toEqual([OVERFLOW_KEY, 'm1', 'm2', 'm3'].sort())
    const overflow = s.aggregates.byModel.find((b) => b.key === OVERFLOW_KEY)
    expect(overflow?.rows).toBe(3)
    expect(overflow?.valueUsd).toBe('0.03')
    expect(s.aggregates.overflowed).toBe(true)
    expect(s.totals.value.exactUsd).toBe('0.06')
  })

  it('uses the default cap of 5000 and reports no overflow below it', () => {
    const agg = new Aggregator()
    expect(agg.cap).toBe(5000)
    for (let i = 0; i < 5000; i++) agg.add(makeAuditRow({ rowIndex: i, model: `model-${i}`, value: '0' }))
    expect(agg.summary().aggregates.overflowed).toBe(false)
    agg.add(makeAuditRow({ rowIndex: 5000, model: 'one-more', value: '0' }))
    const s = agg.summary()
    expect(s.aggregates.overflowed).toBe(true)
    expect(s.aggregates.byModel).toHaveLength(5001)
  })

  it('marks a partial total and counts coverage', () => {
    const agg = new Aggregator()
    agg.add(makeAuditRow({ kind: 'Estimated', value: '0.005615' }))
    agg.add(makeAuditRow({ kind: 'Measured charge', value: '0.95', model: 'openai/gpt-4o' }))
    agg.add(makeAuditRow({ kind: 'Estimated', value: '0', model: 'codestral/codestral-latest' }))
    agg.add(makeAuditRow({ kind: 'Not priced', model: 'acme-unlisted-model-x' }))
    agg.add(makeAuditRow({ kind: 'Not priced', model: null }))
    agg.add(makeAuditRow({ kind: 'Not priced', model: 'acme-unlisted-model-x' }))
    agg.add(makeAuditRow({ kind: 'Unresolved', malformed: true, model: null }))
    agg.add(makeAuditRow({ kind: 'Unresolved', counted: false, model: 'gpt-4o', value: null }))
    const s = agg.summary()
    expect(s.coverage).toEqual({
      totalRows: 8,
      countedRows: 7,
      rowsWithProviderUsage: 6,
      rowsPriced: 3,
      rowsNotPriced: 3,
      rowsUnresolved: 1,
      rowsMalformed: 1,
    })
    expect(s.totals.partial).toBe(true)
    expect(s.totals.partialReason).toBe('3 rows Not priced and 1 row Unresolved are left out')
    expect(s.totals.value).toEqual({ exactUsd: '0.955615', displayUsd: '$0.955615' })
    expect(s.totals.measuredCharge.exactUsd).toBe('0.95')
    expect(s.totals.estimated.exactUsd).toBe('0.005615')
    const byLabel = Object.fromEntries(s.aggregates.byLabel.map((b) => [b.key, b.rows]))
    expect(byLabel).toEqual({ Estimated: 2, 'Measured charge': 1, 'Not priced': 3, Unresolved: 1 })
    expect(s.aggregates.byModel.find((b) => b.key === '(no model)')?.rowsNotPriced).toBe(1)
    expect(s.aggregates.byModel.find((b) => b.key === '(no model)')?.rowsUnresolved).toBe(1)
    expect(() => AuditSummary.shape.coverage.parse(s.coverage)).not.toThrow()
  })

  it('a full total has no partial marker; one left-out row reads in the singular', () => {
    const full = new Aggregator()
    full.add(makeAuditRow({ value: '1' }))
    expect(full.summary().totals).toMatchObject({ partial: false, partialReason: null })
    const one = new Aggregator()
    one.add(makeAuditRow({ kind: 'Not priced' }))
    expect(one.summary().totals.partialReason).toBe('1 row Not priced is left out')
  })

  it('groups by day and provider, sums tokens and excluded usage over counted rows', () => {
    const agg = new Aggregator()
    agg.add(makeAuditRow({ timestamp: '2026-09-02T23:59:59.000Z', uncached: 10, cacheRead: 5, write5m: 2, output: 7, reasoning: 3, excluded: { input_audio: 4 } }))
    agg.add(makeAuditRow({ timestamp: '2026-09-01T00:00:00.000Z', provider: 'anthropic', excluded: { input_audio: 1, web_search_requests: 2 } }))
    agg.add(makeAuditRow({ timestamp: null, provider: null }))
    agg.add(makeAuditRow({ counted: false, excluded: { input_audio: 100 } }))
    const s = agg.summary()
    expect(s.aggregates.byDay.map((b) => b.key)).toEqual(['(no time)', '2026-09-01', '2026-09-02'])
    expect(s.aggregates.byDay.find((b) => b.key === '2026-09-02')?.tokens).toEqual({ uncachedInput: 10, cacheRead: 5, cacheWrite: 2, output: 7, reasoning: 3 })
    expect(s.aggregates.byProvider.map((b) => b.key).sort()).toEqual(['(no provider)', 'anthropic', 'openai'])
    expect(s.excludedFromCost).toEqual({ input_audio: 5, web_search_requests: 2 })
  })

  it('builds model by input band sums, time buckets use input per request', () => {
    expect(inputBand(999)).toBe('<1k')
    expect(inputBand(1000)).toBe('1k-10k')
    expect(inputBand(10000)).toBe('10k-100k')
    expect(inputBand(100000)).toBe('>=100k')
    const agg = new Aggregator()
    agg.add(makeAuditRow({ uncached: 500, cacheRead: 600, value: '0.1' }))
    agg.add(makeAuditRow({ uncached: 900, value: '0.2' }))
    agg.add(makeAuditRow({ granularity: 'time_bucket', uncached: 50000, requests: 100, value: '0.3' }))
    agg.add(makeAuditRow({ granularity: 'time_bucket', uncached: 50000, requests: 2, value: '0.4' }))
    agg.add(makeAuditRow({ kind: 'Not priced', uncached: 900 }))
    const bands = agg.summary().bands
    const find = (band: string, priced: boolean) => bands.find((b) => b.model === 'gpt-4o' && b.band === band && b.priced === priced)
    expect(find('1k-10k', true)).toMatchObject({ requests: 1, uncachedInput: 500, cacheRead: 600, valueUsd: '0.1' })
    expect(find('<1k', true)).toMatchObject({ requests: 101, uncachedInput: 50900, valueUsd: '0.5' })
    expect(find('10k-100k', true)).toMatchObject({ requests: 2, valueUsd: '0.4' })
    expect(find('<1k', false)).toMatchObject({ requests: 1, uncachedInput: 900, valueUsd: '0' })
  })
})
