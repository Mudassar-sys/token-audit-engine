import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PricingManifest, PricingSnapshot } from '../../src/engine/contracts'
import { rateToFemto } from '../../src/engine/money'
import {
  buildSnapshot,
  COMMITS_URL,
  RefreshError,
  rawRegistryUrl,
  refreshPricing,
  sha256Hex,
} from '../../scripts/refresh-pricing'
import { validatePricing } from '../../scripts/validate-pricing'

const SHA = 'cd42694b48e30ab74ba6e24e83aabf4b40c041b5'

/** Decimal spellings as they appear in the registry file, including forms a float round trip would change. */
const SPELLINGS = ['2.5e-06', '0.0000025', '1e-05', '1.25E-6', '3.0e-7', '0.0', '0', '1.875e-06', '0.000000150', '4.25e-06']

interface Synthetic {
  text: string
  /** model -> rate key -> exact text written in the registry */
  rates: Record<string, Record<string, string>>
}

function registry(opts: { models?: number; extra?: string[]; dropSentinel?: string } = {}): Synthetic {
  const count = opts.models ?? 1100
  const rates: Record<string, Record<string, string>> = {}
  const parts: string[] = []
  parts.push('"sample_spec": {"input_cost_per_token": 0, "litellm_provider": "one of the providers", "mode": "chat"}')
  const names = ['gpt-4o', 'claude-sonnet-4-5', ...Array.from({ length: count - 2 }, (_, i) => `vendor-${i % 7}/model-${i}`)]
  names.forEach((name, i) => {
    if (name === opts.dropSentinel) return
    const a = SPELLINGS[i % SPELLINGS.length]!
    const b = SPELLINGS[(i + 3) % SPELLINGS.length]!
    const c = SPELLINGS[(i + 5) % SPELLINGS.length]!
    rates[name] = { input_cost_per_token: a, output_cost_per_token: b, cache_read_input_token_cost_above_272k_tokens_priority: c }
    parts.push(
      `${JSON.stringify(name)}: {"input_cost_per_token": ${a}, "output_cost_per_token": ${b}, ` +
        `"cache_read_input_token_cost_above_272k_tokens_priority": ${c}, "input_cost_per_audio_token": 1.234567890123456789e-9, ` +
        `"litellm_provider": "${i % 2 ? 'openai' : 'anthropic'}", "mode": "chat", "max_input_tokens": 128000, "supports_vision": true}`,
    )
  })
  parts.push(...(opts.extra ?? []))
  return { text: `{\n  ${parts.join(',\n  ')}\n}\n`, rates }
}

const TOO_PRECISE = '"vendor-x/too-precise": {"input_cost_per_token": 2.857142857142857e-07, "output_cost_per_token": 1e-06, "litellm_provider": "vendor-x", "mode": "chat"}'

function mockFetch(text: string, sha: unknown = SHA) {
  const calls: { url: string; auth: string | null }[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, auth: headers.Authorization ?? null })
    if (url === COMMITS_URL) return new Response(JSON.stringify([{ sha }]), { status: 200 })
    if (typeof sha === 'string' && url === rawRegistryUrl(sha)) return new Response(text, { status: 200 })
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { impl, calls }
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pricing-test-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function snapshotState(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const f of (await readdir(dir)).sort()) out[f] = sha256Hex(await readFile(join(dir, f)))
  return out
}

describe('refreshPricing', () => {
  it('two runs on the same day write two immutable files and the manifest lists both', async () => {
    const reg = registry({ extra: [TOO_PRECISE] })
    const { impl, calls } = mockFetch(reg.text)
    const first = await refreshPricing({ fetchImpl: impl, outDir: dir, now: new Date('2026-10-29T08:00:00Z'), token: 'test-token' })
    expect(calls[0]).toEqual({ url: COMMITS_URL, auth: 'Bearer test-token' })
    expect(calls[1]?.url).toBe(rawRegistryUrl(SHA))
    const firstBytes = await readFile(first.path)
    expect(first.file).toBe(`2026-10-29-${sha256Hex(firstBytes).slice(0, 8)}.json`)

    const second = await refreshPricing({ fetchImpl: impl, outDir: dir, now: new Date('2026-10-29T09:30:00Z'), token: null })
    expect(second.file).not.toBe(first.file)
    expect(second.file.startsWith('2026-10-29-')).toBe(true)
    expect((await readFile(first.path)).equals(firstBytes)).toBe(true)

    // Same instant again gives identical bytes and the same name, so a suffix is added instead of overwriting.
    const third = await refreshPricing({ fetchImpl: impl, outDir: dir, now: new Date('2026-10-29T08:00:00Z'), token: null })
    expect(third.file).toBe(first.file.replace('.json', '-2.json'))
    expect((await readFile(first.path)).equals(firstBytes)).toBe(true)

    const manifest = PricingManifest.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')))
    expect(manifest.snapshots.map((s) => s.file)).toEqual([first.file, second.file, third.file])
    expect(manifest.latest).toBe(third.file)
    expect(manifest.snapshots[0]?.sha256).toBe(sha256Hex(firstBytes))
    expect(manifest.snapshots[0]?.commit).toBe(SHA)
    expect(manifest.snapshots[0]?.models).toBe(1100)

    const report = await validatePricing(dir)
    expect(report.errors).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.checked).toHaveLength(3)
  })

  it('every kept rate round-trips to its exact original decimal text', async () => {
    const reg = registry()
    const { impl } = mockFetch(reg.text)
    const r = await refreshPricing({ fetchImpl: impl, outDir: dir, now: new Date('2026-10-29T08:00:00Z'), token: null })
    const snap = PricingSnapshot.parse(JSON.parse(await readFile(r.path, 'utf8')))
    expect(Object.keys(snap.models)).toHaveLength(Object.keys(reg.rates).length)
    for (const [model, rates] of Object.entries(reg.rates)) {
      expect(snap.models[model]?.rates).toEqual(rates)
      for (const text of Object.values(snap.models[model]!.rates)) expect(typeof rateToFemto(text)).toBe('bigint')
    }
    // Spellings a float would rewrite are kept as written.
    expect(snap.models['gpt-4o']?.rates.input_cost_per_token).toBe('2.5e-06')
    const kept = Object.values(snap.models).flatMap((m) => Object.values(m.rates))
    expect(kept).toContain('0.000000150')
    expect(kept).toContain('1.25E-6')
    expect(kept).toContain('3.0e-7')
    // Keys outside the kept pattern are dropped.
    expect(snap.models['gpt-4o']?.rates).not.toHaveProperty('input_cost_per_audio_token')
    expect(snap.models['gpt-4o']?.provider).toBe('anthropic')
    expect(snap.models['sample_spec']).toBeUndefined()
    expect(snap.source.url).toBe(rawRegistryUrl(SHA))
  })

  it('a model with a rate finer than 1e-15 lands in leftOut and is not rounded', () => {
    const reg = registry({ extra: [TOO_PRECISE] })
    const snap = buildSnapshot(reg.text, { commit: SHA, fetchedAt: '2026-10-29T08:00:00.000Z', date: '2026-10-29' })
    expect(snap.models['vendor-x/too-precise']).toBeUndefined()
    const left = snap.leftOut.find((l) => l.model === 'vendor-x/too-precise')
    expect(left?.reason).toContain('finer than 1e-15')
    expect(left?.reason).toContain('2.857142857142857e-07')
  })

  it('non-model entries are listed in leftOut', () => {
    const reg = registry({ extra: ['"fallback_rules": {"rules": []}'] })
    const snap = buildSnapshot(reg.text, { commit: SHA, fetchedAt: '2026-10-29T08:00:00.000Z', date: '2026-10-29' })
    expect(snap.leftOut).toEqual([{ model: 'fallback_rules', reason: 'not a model entry (no litellm_provider)' }])
  })

  const failures: [string, () => { text: string; sha?: unknown }, RegExp][] = [
    ['fewer than 1,000 models', () => ({ text: registry({ models: 999 }).text }), /at least 1000/],
    ['a missing sentinel', () => ({ text: registry({ dropSentinel: 'claude-sonnet-4-5' }).text }), /Sentinel model "claude-sonnet-4-5"/],
    ['a negative rate', () => ({ text: registry({ extra: ['"neg": {"input_cost_per_token": -1e-6, "litellm_provider": "x"}'] }).text }), /Negative kept rate/],
    ['a non-numeric rate', () => ({ text: registry({ extra: ['"str": {"input_cost_per_token": "0.000001", "litellm_provider": "x"}'] }).text }), /Non-numeric kept rate/],
    ['a bad commit sha', () => ({ text: registry().text, sha: 'main' }), /Bad commit sha/],
    ['invalid JSON', () => ({ text: '{"gpt-4o": ' }), /not valid JSON/],
    [
      'too many left out',
      () => ({ text: registry({ extra: Array.from({ length: 80 }, (_, i) => TOO_PRECISE.replace('too-precise', `too-precise-${i}`)) }).text }),
      /above the 5% limit/,
    ],
  ]

  for (const [name, make, message] of failures) {
    it(`fails on ${name} and leaves files untouched`, async () => {
      const ok = mockFetch(registry().text)
      await refreshPricing({ fetchImpl: ok.impl, outDir: dir, now: new Date('2026-10-28T08:00:00Z'), token: null })
      const before = await snapshotState()
      const { text, sha } = make()
      const bad = mockFetch(text, sha ?? SHA)
      const run = refreshPricing({ fetchImpl: bad.impl, outDir: dir, now: new Date('2026-10-29T08:00:00Z'), token: null })
      await expect(run).rejects.toThrow(RefreshError)
      await expect(run).rejects.toThrow(message)
      expect(await snapshotState()).toEqual(before)
    })
  }

  it('fails on an HTTP error without writing anything', async () => {
    const impl = (async () => new Response('rate limited', { status: 403 })) as typeof fetch
    await expect(refreshPricing({ fetchImpl: impl, outDir: dir, now: new Date(), token: null })).rejects.toThrow(/HTTP 403/)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('validatePricing', () => {
  it('fails on a tampered snapshot, a missing file or a bad rate', async () => {
    const { impl } = mockFetch(registry().text)
    const r = await refreshPricing({ fetchImpl: impl, outDir: dir, now: new Date('2026-10-29T08:00:00Z'), token: null })
    expect((await validatePricing(dir)).ok).toBe(true)

    const text = await readFile(r.path, 'utf8')
    await writeFile(r.path, text.replace('"2.5e-06"', '"2.5e-30"'))
    const tampered = await validatePricing(dir)
    expect(tampered.ok).toBe(false)
    expect(tampered.errors.some((e) => e.includes('SHA-256'))).toBe(true)
    expect(tampered.errors.some((e) => e.includes('precision'))).toBe(true)

    await rm(r.path)
    const missing = await validatePricing(dir)
    expect(missing.ok).toBe(false)
    expect(missing.errors.some((e) => e.includes('missing'))).toBe(true)
  })

  it('the committed snapshots are valid', async () => {
    const report = await validatePricing(join(__dirname, '..', '..', 'public', 'pricing'))
    expect(report.errors).toEqual([])
    expect(report.checked.length).toBeGreaterThan(0)
  })
})
