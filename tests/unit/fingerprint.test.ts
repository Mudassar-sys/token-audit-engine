import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ENGINE_FINGERPRINT } from '../../src/engine/fingerprint.generated'
import {
  collectEngineSources,
  collectFingerprintInputs,
  computeEngineFingerprint,
  fingerprintOf,
  FINGERPRINT_DEPENDENCIES,
  FINGERPRINT_ROOTS,
  GENERATED_FILE,
  generatedFileText,
  normalizeLineEndings,
} from '../../scripts/engine-fingerprint'

const repo = process.cwd()
const copies: string[] = []

/** Copy the fingerprinted folders and the lockfile into a new directory, as a fresh checkout would have them. */
function freshCopy(transform?: (path: string, text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fingerprint-'))
  copies.push(dir)
  for (const root of FINGERPRINT_ROOTS) cpSync(join(repo, root), join(dir, root), { recursive: true })
  cpSync(join(repo, 'package-lock.json'), join(dir, 'package-lock.json'))
  if (transform) {
    for (const f of collectEngineSources(dir)) writeFileSync(join(dir, f.path), transform(f.path, f.content))
  }
  return dir
}

afterAll(() => {
  for (const d of copies) rmSync(d, { recursive: true, force: true })
})

describe('engine build fingerprint', () => {
  it('rebuilding it from the source files gives the value the build produced', () => {
    expect(ENGINE_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/)
    expect(computeEngineFingerprint(repo)).toBe(ENGINE_FINGERPRINT)
    expect(normalizeLineEndings(readFileSync(join(repo, GENERATED_FILE), 'utf8'))).toBe(generatedFileText(ENGINE_FINGERPRINT))
  })

  it('covers the engine, adapter and worker sources and the locked libraries, and leaves out the generated file', () => {
    const paths = collectFingerprintInputs(repo).map((f) => f.path)
    expect(paths).toContain('src/engine/pricing.ts')
    expect(paths).toContain('src/engine/adapters/openaiChat.ts')
    expect(paths).toContain('src/engine/contracts.ts')
    expect(paths).toContain('src/worker/engine.worker.ts')
    expect(paths).toContain('src/worker/store.ts')
    for (const dep of FINGERPRINT_DEPENDENCIES) expect(paths).toContain(`package-lock.json#node_modules/${dep}`)
    expect(paths).not.toContain(GENERATED_FILE)
    for (const p of paths) expect(p.includes('\\')).toBe(false)
  })

  it('is the same on a fresh checkout in another folder, with CRLF line endings and a stale generated file', () => {
    const dir = freshCopy((_p, text) => normalizeLineEndings(text).replace(/\n/g, '\r\n'))
    writeFileSync(join(dir, GENERATED_FILE), generatedFileText('0'.repeat(64)))
    expect(computeEngineFingerprint(dir)).toBe(ENGINE_FINGERPRINT)
  })

  it('does not depend on the order files are listed in', () => {
    const files = collectFingerprintInputs(repo)
    expect(fingerprintOf([...files].reverse())).toBe(fingerprintOf(files))
  })

  it('changes when any calculation source file or locked library changes', () => {
    const files = collectFingerprintInputs(repo)
    const base = fingerprintOf(files)
    for (let i = 0; i < files.length; i++) {
      const changed = files.map((f, j) => (j === i ? { ...f, content: `${f.content}\n// edited` } : f))
      expect(fingerprintOf(changed), files[i]!.path).not.toBe(base)
    }
    // A renamed file changes it too, even with the same content.
    const renamed = files.map((f, j) => (j === 0 ? { ...f, path: `${f.path}.moved` } : f))
    expect(fingerprintOf(renamed)).not.toBe(base)
  })

  it('changes on a fresh checkout when one source file is edited', () => {
    const dir = freshCopy((path, text) => (path === 'src/engine/pricing.ts' ? `${text}\nexport const edited = 1\n` : text))
    expect(computeEngineFingerprint(dir)).not.toBe(ENGINE_FINGERPRINT)
  })

  it('changes on a fresh checkout when a locked library version changes', () => {
    const dir = freshCopy()
    const lockPath = join(dir, 'package-lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { packages: Record<string, { version: string }> }
    lock.packages['node_modules/papaparse']!.version = '0.0.0-edited'
    writeFileSync(lockPath, JSON.stringify(lock))
    expect(computeEngineFingerprint(dir)).not.toBe(ENGINE_FINGERPRINT)
  })
})
