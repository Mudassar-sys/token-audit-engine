/**
 * Validate every pricing snapshot listed in public/pricing/manifest.json:
 * the file exists, its SHA-256 matches, it is schema-valid, and every rate converts exactly.
 * Exit code 1 on any failure.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PricingManifest, PricingSnapshot } from '../src/engine/contracts'
import { rateToFemto } from '../src/engine/money'

export interface ValidationReport {
  ok: boolean
  checked: string[]
  errors: string[]
}

export async function validatePricing(dir: string = fileURLToPath(new URL('../public/pricing/', import.meta.url))): Promise<ValidationReport> {
  const errors: string[] = []
  const checked: string[] = []
  let manifest: PricingManifest
  try {
    manifest = PricingManifest.parse(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')))
  } catch (e) {
    return { ok: false, checked, errors: [`manifest.json: ${e instanceof Error ? e.message : String(e)}`] }
  }
  if (manifest.snapshots.length === 0) errors.push('manifest.json lists no snapshots')
  if (!manifest.snapshots.some((s) => s.file === manifest.latest)) errors.push(`latest "${manifest.latest}" is not listed in snapshots`)
  const seen = new Set<string>()

  for (const entry of manifest.snapshots) {
    const where = entry.file
    if (seen.has(entry.file)) errors.push(`${where}: listed twice`)
    seen.add(entry.file)
    if (!/^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}(-\d+)?\.json$/.test(entry.file) || entry.file.includes('/') || entry.file.includes('\\')) {
      errors.push(`${where}: unexpected file name`)
      continue
    }
    let bytes: Buffer
    try {
      bytes = await readFile(join(dir, entry.file))
    } catch {
      errors.push(`${where}: file is missing`)
      continue
    }
    checked.push(entry.file)
    const sha = createHash('sha256').update(bytes).digest('hex')
    if (sha !== entry.sha256) errors.push(`${where}: SHA-256 ${sha} does not match the manifest ${entry.sha256}`)
    if (!entry.file.startsWith(`${entry.date}-${entry.sha256.slice(0, 8)}`)) errors.push(`${where}: name does not carry its date and hash prefix`)

    let snapshot: PricingSnapshot
    try {
      snapshot = PricingSnapshot.parse(JSON.parse(bytes.toString('utf8')))
    } catch (e) {
      errors.push(`${where}: schema check failed: ${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (snapshot.date !== entry.date) errors.push(`${where}: date ${snapshot.date} differs from the manifest ${entry.date}`)
    if (snapshot.source.commit !== entry.commit) errors.push(`${where}: commit differs from the manifest`)
    if (Object.keys(snapshot.models).length !== entry.models) errors.push(`${where}: model count differs from the manifest`)
    const kept = new RegExp(snapshot.keptRateKeyPattern)
    let rateErrors = 0
    for (const [model, m] of Object.entries(snapshot.models)) {
      for (const [key, text] of Object.entries(m.rates)) {
        let bad: string | null = null
        if (!kept.test(key)) bad = 'key outside the kept pattern'
        else {
          try {
            if (rateToFemto(text) < 0n) bad = 'negative rate'
          } catch (e) {
            bad = e instanceof Error ? e.message : String(e)
          }
        }
        if (bad && rateErrors++ < 20) errors.push(`${where}: ${model}.${key} = "${text}": ${bad}`)
      }
    }
    if (rateErrors > 20) errors.push(`${where}: ${rateErrors - 20} more rate errors`)
  }
  return { ok: errors.length === 0, checked, errors }
}

function isMain(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const a = resolve(fileURLToPath(import.meta.url))
  const b = resolve(entry)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

if (isMain()) {
  validatePricing(process.argv[2])
    .then((r) => {
      for (const f of r.checked) console.log(`checked ${f}`)
      if (!r.ok) {
        for (const e of r.errors) console.error(e)
        process.exit(1)
      }
      console.log('All pricing snapshots are valid.')
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    })
}
