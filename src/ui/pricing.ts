import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { PricingManifest, PricingSnapshot, type FrozenSnapshot } from '../engine/contracts'

/**
 * Loads the pricing snapshot named as latest in the manifest, checks its SHA-256
 * against the manifest and validates it. Cached in memory for the page's lifetime.
 * An audit keeps the snapshot it used; a newer one never recalculates it.
 */

export interface LoadedPricing {
  snapshot: PricingSnapshot
  meta: FrozenSnapshot & { sourceUrl: string }
  manifest: PricingManifest
}

export class PricingIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PricingIntegrityError'
  }
}

const MANIFEST_URL = '/pricing/manifest.json'

let cached: Promise<LoadedPricing> | null = null

/** Resolve a manifest file entry to a same-origin path under /pricing/. */
export function snapshotPath(file: string): string {
  const name = file.split('/').pop() ?? file
  if (!/^[\w.-]+\.json$/.test(name)) throw new PricingIntegrityError(`Snapshot file name is not valid: ${file}`)
  return `/pricing/${name}`
}

/** Pick the manifest entry named by `latest` (file name or date), else the last entry. */
export function latestEntry(manifest: PricingManifest): PricingManifest['snapshots'][number] {
  const byName = manifest.snapshots.find((s) => s.file === manifest.latest || s.file.endsWith(`/${manifest.latest}`))
  const byDate = manifest.snapshots.filter((s) => s.date === manifest.latest).pop()
  const entry = byName ?? byDate ?? manifest.snapshots[manifest.snapshots.length - 1]
  if (!entry) throw new PricingIntegrityError('The pricing manifest lists no snapshots.')
  return entry
}

export function sha256HexOf(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes))
}

async function fetchBytes(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const res = await fetchImpl(url, { cache: 'no-cache', credentials: 'same-origin' })
  if (!res.ok) throw new Error(`Could not load ${url} (status ${res.status}).`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Fetch, verify and parse. Exposed for tests; the app uses loadPricing(). */
export async function fetchPricing(fetchImpl: typeof fetch = fetch): Promise<LoadedPricing> {
  const manifestBytes = await fetchBytes(MANIFEST_URL, fetchImpl)
  const manifest = PricingManifest.parse(JSON.parse(new TextDecoder().decode(manifestBytes)))
  const entry = latestEntry(manifest)
  const bytes = await fetchBytes(snapshotPath(entry.file), fetchImpl)
  const actual = sha256HexOf(bytes)
  if (actual !== entry.sha256) {
    throw new PricingIntegrityError(`Pricing snapshot ${entry.file} does not match the manifest hash. Expected ${entry.sha256}, got ${actual}.`)
  }
  const snapshot = PricingSnapshot.parse(JSON.parse(new TextDecoder().decode(bytes)))
  return {
    snapshot,
    manifest,
    meta: { file: entry.file.split('/').pop() ?? entry.file, date: snapshot.date, sha256: actual, commit: snapshot.source.commit, sourceUrl: snapshot.source.url },
  }
}

/** Cached loader. A failed load is not cached, so a retry fetches again. */
export function loadPricing(): Promise<LoadedPricing> {
  if (!cached) {
    cached = fetchPricing()
    cached.catch(() => {
      cached = null
    })
  }
  return cached
}

const frozenCache = new Map<string, Promise<PricingSnapshot>>()

/**
 * The snapshot an audit was priced with. The loaded snapshot is used when its SHA-256 is the
 * audit's; otherwise the audit's own file is fetched and its bytes checked against the audit's SHA-256.
 */
export function loadFrozenSnapshot(
  frozen: Pick<FrozenSnapshot, 'file' | 'sha256'>,
  loaded: Pick<LoadedPricing, 'snapshot' | 'meta'> | null,
  fetchImpl: typeof fetch = fetch,
): Promise<PricingSnapshot> {
  if (loaded && loaded.meta.sha256 === frozen.sha256) return Promise.resolve(loaded.snapshot)
  let p = frozenCache.get(frozen.sha256)
  if (!p) {
    p = (async () => {
      const bytes = await fetchBytes(snapshotPath(frozen.file), fetchImpl)
      const actual = sha256HexOf(bytes)
      if (actual !== frozen.sha256) {
        throw new PricingIntegrityError(`Pricing snapshot ${frozen.file} does not match the audit. Expected ${frozen.sha256}, got ${actual}.`)
      }
      return PricingSnapshot.parse(JSON.parse(new TextDecoder().decode(bytes)))
    })()
    frozenCache.set(frozen.sha256, p)
    p.catch(() => frozenCache.delete(frozen.sha256))
  }
  return p
}
