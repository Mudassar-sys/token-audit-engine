import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DecimalString, PricingSnapshot, type RoutingAssumptions } from '../../src/engine/contracts'
import { BASELINE_LABEL, modelBaseline, modelRouting, SavingsInputError, type Band } from '../../src/engine/savings'

const ROOT = join(__dirname, '..', '..')
const worked = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'worked-examples.json'), 'utf8')) as { snapshot: { file: string } }
const snapshot = PricingSnapshot.parse(JSON.parse(readFileSync(join(ROOT, 'public', 'pricing', worked.snapshot.file), 'utf8')))

const bands: Band[] = [
  // 10000 x 0.0000025 + 5000 x 0.00000125 + 2000 x 0.00001 = 0.05125
  { model: 'gpt-4o', resolvedKey: 'gpt-4o', band: '1k-10k', requests: 10, uncachedInput: 10000, cacheRead: 5000, cacheWrite: 0, output: 2000, valueUsd: '0.05125', priced: true },
  // 2000 x 0.000003 + 1000 x 0.0000003 + 400 x 0.00000375 + 800 x 0.000015 = 0.0198
  { model: 'claude-sonnet-4-5-20250929', resolvedKey: 'claude-sonnet-4-5-20250929', band: '<1k', requests: 4, uncachedInput: 2000, cacheRead: 1000, cacheWrite: 400, output: 800, valueUsd: '0.0198', priced: true },
  { model: 'acme-unlisted-model-x', resolvedKey: null, band: '<1k', requests: 3, uncachedInput: 300, cacheRead: 0, cacheWrite: 0, output: 30, valueUsd: '0', priced: false },
]

function routing(over: Partial<RoutingAssumptions> = {}): RoutingAssumptions {
  return {
    sourceModels: ['claude-sonnet-4-5-20250929'],
    inputBands: [],
    targetModel: 'gpt-4o-mini',
    eligibleShare: '0.5',
    outputLengthRatio: '1',
    tokenizerRatio: '1',
    retryFallbackRate: '0',
    routingOverheadTokens: 0,
    calibrationPassRate: null,
    ...over,
  }
}

describe('modelBaseline', () => {
  it('reprices priced bands at the baseline list price', () => {
    const r = modelBaseline(bands, snapshot, 'gpt-4o-mini')
    expect(r.baselineLabel).toBe(BASELINE_LABEL)
    expect(r.baselineLabel).toBe('Modelled: the baseline never ran')
    expect(r.label.kind).toBe('Estimated')
    expect(r.quality).toBe('unverified')
    expect(r.actual.exactUsd).toBe('0.07105')
    // band 1: 0.0015 + 0.000375 + 0.0012; band 2: 0.0003 + 0.000075 + 0.00006 (writes at input) + 0.00048
    expect(r.baseline.exactUsd).toBe('0.00399')
    expect(r.difference.exactUsd).toBe('-0.06706')
    expect(r.difference.displayUsd).toBe('-$0.067060')
    expect(r.bandsUsed).toBe(2)
    expect(r.skipped).toHaveLength(1)
    expect(r.assumptions.some((a) => a.includes('cache writes are priced as uncached input'))).toBe(true)
  })

  it('uses the baseline write rate when it has one', () => {
    const r = modelBaseline(bands, snapshot, 'claude-sonnet-4-5-20250929')
    // band 1: 0.03 + 0.0015 + 0.03; band 2 equals its logged value
    expect(r.baseline.exactUsd).toBe('0.0813')
    expect(r.assumptions.some((a) => a.includes('5 minute write rate'))).toBe(true)
  })

  it('rejects an unknown baseline', () => {
    expect(() => modelBaseline(bands, snapshot, 'acme-unlisted-model-x')).toThrow(SavingsInputError)
  })
})

describe('modelRouting', () => {
  it('moves the eligible share to the target', () => {
    const r = modelRouting(bands, snapshot, routing())
    expect(r.original.exactUsd).toBe('0.07105')
    // 0.05125 + 0.0198 x 0.5 + 0.000915 x 0.5
    expect(r.scenario.exactUsd).toBe('0.0616075')
    expect(r.savings.exactUsd).toBe('0.0094425')
    expect(r.bandsEligible).toBe(1)
    expect(r.bandsUsed).toBe(2)
    expect(r.quality).toBe('unverified')
    expect(r.label.kind).toBe('Estimated')
    expect(r.assumptions.join(' ')).toContain('user-supplied assumption')
  })

  it('applies retries, calibration fallback, overhead and ratios exactly', () => {
    expect(modelRouting(bands, snapshot, routing({ retryFallbackRate: '0.1' })).savings.exactUsd).toBe('0.00939675')
    expect(modelRouting(bands, snapshot, routing({ calibrationPassRate: '0.8' })).savings.exactUsd).toBe('0.0074625')
    // 400 overhead tokens x 0.00000015 x 0.5 = 0.00003 more
    expect(modelRouting(bands, snapshot, routing({ routingOverheadTokens: 100 })).savings.exactUsd).toBe('0.0094125')
    // target cost 0.00081 x 0.5 = 0.000405
    expect(modelRouting(bands, snapshot, routing({ tokenizerRatio: '1.2', outputLengthRatio: '0.5' })).savings.exactUsd).toBe('0.009495')
  })

  it('a share of zero changes nothing, and a share of one moves everything', () => {
    expect(modelRouting(bands, snapshot, routing({ eligibleShare: '0' })).savings.exactUsd).toBe('0')
    expect(modelRouting(bands, snapshot, routing({ eligibleShare: '1' })).scenario.exactUsd).toBe('0.052165')
  })

  it('shows a negative result when the scenario costs more', () => {
    const r = modelRouting(bands, snapshot, routing({ sourceModels: ['gpt-4o'], targetModel: 'claude-sonnet-4-5-20250929', eligibleShare: '1' }))
    expect(r.savings.exactUsd.startsWith('-')).toBe(true)
    expect(r.savings.exactUsd).toBe('-0.01025')
    expect(r.savings.displayUsd).toBe('-$0.010250')
  })

  it('filters by input band and accepts empty lists as all', () => {
    expect(modelRouting(bands, snapshot, routing({ inputBands: ['>=100k'] })).bandsEligible).toBe(0)
    expect(modelRouting(bands, snapshot, routing({ sourceModels: [], inputBands: ['<1k', '1k-10k'] })).bandsEligible).toBe(2)
  })

  it('rounds once and keeps exact decimal text', () => {
    const r = modelRouting(bands, snapshot, routing({ eligibleShare: '0.333333', tokenizerRatio: '1.111111', outputLengthRatio: '0.777777', retryFallbackRate: '0.012345' }))
    for (const v of [r.original, r.scenario, r.savings]) expect(DecimalString.safeParse(v.exactUsd).success).toBe(true)
  })

  it('rejects invalid assumptions', () => {
    expect(() => modelRouting(bands, snapshot, routing({ eligibleShare: '1.5' }))).toThrow(SavingsInputError)
    expect(() => modelRouting(bands, snapshot, routing({ eligibleShare: '-0.1' }))).toThrow(SavingsInputError)
    expect(() => modelRouting(bands, snapshot, routing({ tokenizerRatio: '0.1234567' }))).toThrow(SavingsInputError)
    expect(() => modelRouting(bands, snapshot, routing({ calibrationPassRate: '2' }))).toThrow(SavingsInputError)
    expect(() => modelRouting(bands, snapshot, routing({ targetModel: null }))).toThrow(SavingsInputError)
    expect(() => modelRouting(bands, snapshot, routing({ targetModel: 'acme-unlisted-model-x' }))).toThrow(SavingsInputError)
  })
})
