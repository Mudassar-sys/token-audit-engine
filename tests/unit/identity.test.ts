import { describe, expect, it } from 'vitest'
import type { IdentityInputs } from '../../src/engine/contracts'
import {
  adapterList,
  calculationIdentity,
  canonicalJson,
  createIncrementalSha256,
  sha256Hex,
} from '../../src/engine/identity'

const base: IdentityInputs = {
  inputFileSha256: 'a'.repeat(64),
  mapping: null,
  adapters: [{ id: 'litellm-spend', version: '1.0.0' }],
  schemaVersion: 1,
  snapshotSha256: 'b'.repeat(64),
  baselineModel: null,
  routing: null,
  priceOverrides: [],
  reportSettings: { displayDecimals: 6, aggregateKeyCap: 5000 },
  engineVersion: '1.0.0',
}

const mapping = {
  timestamp: 'ts',
  provider: null,
  model: 'model',
  inputTokens: 'in',
  inputIncludesCached: true,
  cacheRead: 'cr',
  cacheWrite: null,
  cacheWriteDuration: null,
  outputTokens: 'out',
  reasoningTokens: null,
  tier: null,
  reportedCharge: null,
}

const routing = {
  sourceModels: ['gpt-4o'],
  inputBands: ['<1k'],
  targetModel: 'gpt-4o-mini',
  eligibleShare: '0.5',
  outputLengthRatio: '1',
  tokenizerRatio: '1',
  retryFallbackRate: '0.02',
  routingOverheadTokens: 20,
  calibrationPassRate: null,
}

/** Rebuild an object with its keys in reverse order, recursively. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys((v as Record<string, unknown>)[k])]))
  }
  return v
}

describe('canonicalJson', () => {
  it('sorts keys recursively, keeps array order, has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"x":2,"y":1}]},"b":1}')
  })

  it('drops undefined members and refuses BigInt and non-finite numbers', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
    expect(() => canonicalJson({ a: 1n })).toThrow(/BigInt/)
    expect(() => canonicalJson({ a: Number.NaN })).toThrow()
  })
})

describe('sha256', () => {
  it('matches the standard test vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('incremental hashing equals one-shot hashing', () => {
    const data = new TextEncoder().encode('hello, \u00e9 world '.repeat(1000))
    const h = createIncrementalSha256()
    for (let i = 0; i < data.length; i += 333) h.update(data.subarray(i, i + 333))
    expect(h.digestHex()).toBe(sha256Hex(data))
    expect(h.digestHex()).toBe(sha256Hex(data))
  })
})

describe('calculationIdentity', () => {
  it('same inputs give the same hash, whatever the key order', () => {
    const a = calculationIdentity(base)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(calculationIdentity(structuredClone(base))).toBe(a)
    expect(calculationIdentity(reverseKeys({ ...base, mapping, routing }) as IdentityInputs)).toBe(
      calculationIdentity({ ...base, mapping, routing }),
    )
  })

  it('changes with the mapping, baseline, routing assumptions, overrides and report settings', () => {
    const a = calculationIdentity(base)
    const variants: IdentityInputs[] = [
      { ...base, mapping },
      { ...base, mapping: { ...mapping, inputIncludesCached: false } },
      { ...base, baselineModel: 'gpt-4o-mini' },
      { ...base, routing },
      { ...base, routing: { ...routing, eligibleShare: '0.6' } },
      { ...base, priceOverrides: [{ model: 'gpt-4o', rateKey: 'input_cost_per_token', rateUsdPerToken: '0.000002' }] },
      { ...base, reportSettings: { displayDecimals: 4, aggregateKeyCap: 5000 } },
      { ...base, reportSettings: { displayDecimals: 6, aggregateKeyCap: 100 } },
      { ...base, inputFileSha256: 'c'.repeat(64) },
      { ...base, snapshotSha256: 'd'.repeat(64) },
      { ...base, adapters: [{ id: 'litellm-spend', version: '1.0.1' }] },
    ]
    const hashes = variants.map(calculationIdentity)
    for (const h of hashes) expect(h).not.toBe(a)
    expect(new Set(hashes).size).toBe(hashes.length)
  })

  it('the export time is not an input', () => {
    const a = calculationIdentity(base)
    const withTime = { ...base, exportedAt: '2026-10-29T12:00:00.000Z' } as IdentityInputs
    const withOtherTime = { ...base, exportedAt: '2027-01-01T00:00:00.000Z' } as IdentityInputs
    expect(calculationIdentity(withTime)).toBe(a)
    expect(calculationIdentity(withOtherTime)).toBe(a)
  })

  it('refuses invalid inputs', () => {
    expect(() => calculationIdentity({ ...base, schemaVersion: 1.5 })).toThrow()
  })
})

describe('adapterList', () => {
  it('names the adapter id and version used for a variant', () => {
    const list = adapterList('F-csv')
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toMatch(/\S/)
    expect(list[0]?.version).toMatch(/\S/)
    expect(adapterList('F-json')).toEqual(list)
  })
})
