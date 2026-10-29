/**
 * Refresh the pricing snapshot from the LiteLLM model registry at a pinned commit.
 * Writes an immutable public/pricing/<date>-<sha8>.json and appends it to manifest.json.
 * Fails loudly (non-zero exit, nothing written) when any check fails, so the last good snapshot stays.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLosslessNumber, parse } from 'lossless-json'
import {
  PricingManifest,
  PricingSnapshot,
  type PricingModelEntry,
} from '../src/engine/contracts'
import { PrecisionError, rateToFemto } from '../src/engine/money'
import { KEPT_RATE_KEY_PATTERN } from '../src/engine/pricing'

export const REGISTRY_REPOSITORY = 'BerriAI/litellm'
export const REGISTRY_PATH = 'model_prices_and_context_window.json'
export const COMMITS_URL = `https://api.github.com/repos/${REGISTRY_REPOSITORY}/commits?path=${REGISTRY_PATH}&per_page=1`
export const rawRegistryUrl = (sha: string): string =>
  `https://raw.githubusercontent.com/${REGISTRY_REPOSITORY}/${sha}/${REGISTRY_PATH}`

export const MIN_MODELS = 1000
/** leftOut may hold at most this share of registry entries. */
export const MAX_LEFT_OUT_SHARE = 0.05
export const SENTINEL_MODELS = ['gpt-4o', 'claude-sonnet-4-5'] as const

const KEPT_RE = new RegExp(KEPT_RATE_KEY_PATTERN)
const SKIPPED_KEYS = new Set(['sample_spec'])

export class RefreshError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshError'
  }
}

export interface BuildInput {
  commit: string
  fetchedAt: string
  date: string
}

/** Turn registry text into a validated snapshot. Pure: no I/O. Throws RefreshError on any failed check. */
export function buildSnapshot(registryText: string, input: BuildInput): PricingSnapshot {
  if (!/^[0-9a-f]{40}$/.test(input.commit)) throw new RefreshError(`Bad commit sha: "${input.commit}"`)
  let root: unknown
  try {
    root = parse(registryText)
  } catch (e) {
    throw new RefreshError(`Registry is not valid JSON: ${(e as Error).message}`)
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) throw new RefreshError('Registry root is not an object')

  const models: Record<string, PricingModelEntry> = {}
  const leftOut: { model: string; reason: string }[] = []
  let entries = 0

  for (const name of Object.keys(root).sort()) {
    if (SKIPPED_KEYS.has(name)) continue
    entries++
    const raw = (root as Record<string, unknown>)[name]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      leftOut.push({ model: name, reason: 'not a model entry (not an object)' })
      continue
    }
    const obj = raw as Record<string, unknown>
    if (typeof obj.litellm_provider !== 'string') {
      leftOut.push({ model: name, reason: 'not a model entry (no litellm_provider)' })
      continue
    }
    const rates: Record<string, string> = {}
    let precisionKey: string | null = null
    for (const key of Object.keys(obj).sort()) {
      if (!KEPT_RE.test(key)) continue
      const v = obj[key]
      if (!isLosslessNumber(v)) throw new RefreshError(`Non-numeric kept rate ${name}.${key}: ${JSON.stringify(v)}`)
      const text = v.value
      if (text.trim().startsWith('-')) throw new RefreshError(`Negative kept rate ${name}.${key}: ${text}`)
      try {
        rateToFemto(text)
      } catch (e) {
        if (e instanceof PrecisionError) {
          precisionKey ??= `${key} = ${text}`
          continue
        }
        throw new RefreshError(`Unreadable kept rate ${name}.${key}: ${text}`)
      }
      rates[key] = text
    }
    if (precisionKey !== null) {
      leftOut.push({ model: name, reason: `rate finer than 1e-15 USD per token, not rounded (${precisionKey})` })
      continue
    }
    models[name] = { provider: obj.litellm_provider, mode: typeof obj.mode === 'string' ? obj.mode : null, rates }
  }

  const kept = Object.keys(models).length
  if (kept < MIN_MODELS) throw new RefreshError(`Only ${kept} models kept; at least ${MIN_MODELS} expected`)
  if (leftOut.length > entries * MAX_LEFT_OUT_SHARE) {
    throw new RefreshError(`${leftOut.length} of ${entries} entries left out, above the ${MAX_LEFT_OUT_SHARE * 100}% limit`)
  }
  for (const s of SENTINEL_MODELS) {
    if (!Object.hasOwn(models, s)) throw new RefreshError(`Sentinel model "${s}" is missing`)
  }

  const candidate = {
    schemaVersion: 1 as const,
    date: input.date,
    source: {
      repository: REGISTRY_REPOSITORY,
      path: REGISTRY_PATH,
      commit: input.commit,
      url: rawRegistryUrl(input.commit),
      fetchedAt: input.fetchedAt,
    },
    keptRateKeyPattern: KEPT_RATE_KEY_PATTERN,
    models,
    leftOut,
  }
  const parsed = PricingSnapshot.safeParse(candidate)
  if (!parsed.success) throw new RefreshError(`Snapshot failed validation: ${parsed.error.message}`)
  return candidate
}

/** Stable file text: two-space JSON with a trailing newline. */
export function serializeSnapshot(snapshot: PricingSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export interface RefreshOptions {
  fetchImpl?: typeof fetch
  outDir?: string
  now?: Date | (() => Date)
  token?: string | null
}

export interface RefreshResult {
  file: string
  path: string
  sha256: string
  commit: string
  models: number
  leftOut: number
  manifest: PricingManifest
}

async function readManifest(path: string): Promise<PricingManifest | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  const parsed = PricingManifest.safeParse(JSON.parse(text))
  if (!parsed.success) throw new RefreshError(`Existing manifest is invalid: ${parsed.error.message}`)
  return parsed.data
}

/** Write bytes to a new file, never overwriting: name.json, then name-2.json, name-3.json... */
async function writeNew(dir: string, stem: string, bytes: Buffer): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const file = n === 1 ? `${stem}.json` : `${stem}-${n}.json`
    try {
      await writeFile(join(dir, file), bytes, { flag: 'wx' })
      return file
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new RefreshError(`Too many snapshots named ${stem}`)
}

export async function refreshPricing(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const outDir = opts.outDir ?? fileURLToPath(new URL('../public/pricing/', import.meta.url))
  const now = typeof opts.now === 'function' ? opts.now() : (opts.now ?? new Date())
  const token = opts.token === undefined ? (process.env.GITHUB_TOKEN ?? null) : opts.token

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'token-audit-engine-pricing-refresh',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const commitsRes = await fetchImpl(COMMITS_URL, { headers })
  if (!commitsRes.ok) throw new RefreshError(`Commit lookup failed: HTTP ${commitsRes.status}`)
  const commits = (await commitsRes.json()) as unknown
  const commit = Array.isArray(commits) ? (commits[0] as { sha?: unknown } | undefined)?.sha : undefined
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new RefreshError(`Bad commit sha from the commit lookup: ${JSON.stringify(commit)}`)
  }

  const url = rawRegistryUrl(commit)
  const regRes = await fetchImpl(url, { headers: { 'User-Agent': headers['User-Agent']! } })
  if (!regRes.ok) throw new RefreshError(`Registry download failed: HTTP ${regRes.status}`)
  const registryText = await regRes.text()

  const fetchedAt = now.toISOString()
  const date = fetchedAt.slice(0, 10)
  const snapshot = buildSnapshot(registryText, { commit, fetchedAt, date })
  const bytes = Buffer.from(serializeSnapshot(snapshot), 'utf8')
  const sha256 = sha256Hex(bytes)

  await mkdir(outDir, { recursive: true })
  const manifestPath = join(outDir, 'manifest.json')
  const existing = await readManifest(manifestPath)

  const file = await writeNew(outDir, `${date}-${sha256.slice(0, 8)}`, bytes)
  const manifest: PricingManifest = {
    latest: file,
    snapshots: [
      ...(existing?.snapshots ?? []),
      { file, date, commit, sha256, sourceUrl: url, fetchedAt, models: Object.keys(snapshot.models).length },
    ],
  }
  PricingManifest.parse(manifest)
  const tmp = `${manifestPath}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(tmp, manifestPath)

  return {
    file,
    path: join(outDir, file),
    sha256,
    commit,
    models: Object.keys(snapshot.models).length,
    leftOut: snapshot.leftOut.length,
    manifest,
  }
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const a = resolve(fileURLToPath(import.meta.url))
  const b = resolve(entry)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

if (isMain()) {
  refreshPricing()
    .then((r) => {
      console.log(`Wrote ${r.path}`)
      console.log(`commit ${r.commit}, ${r.models} models, ${r.leftOut} left out, sha256 ${r.sha256}`)
    })
    .catch((e: unknown) => {
      console.error(`Pricing refresh failed: ${e instanceof Error ? e.message : String(e)}`)
      console.error('No snapshot was added to the manifest; the last good snapshot stays latest.')
      process.exit(1)
    })
}
