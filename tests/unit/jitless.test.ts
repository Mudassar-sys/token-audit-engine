import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Runs in a fresh Node process: counts calls to the Function constructor while the contracts
 * load and parse. zod's eval probe is such a call, and a strict script-src policy reports it.
 */
function evalProbes(setup: string | null): number {
  const script = `
    const Real = globalThis.Function
    let calls = 0
    globalThis.Function = new Proxy(Real, { construct(t, a) { calls++; return Reflect.construct(t, a) }, apply(t, s, a) { calls++; return Reflect.apply(t, s, a) } })
    ${setup ? `await import(${JSON.stringify(setup)})` : ''}
    const c = await import('./src/engine/contracts.ts')
    c.CustomCsvMapping.parse({ timestamp: null, provider: null, model: null, inputTokens: 'a', inputIncludesCached: true, cacheRead: null, cacheWrite: null, cacheWriteDuration: null, outputTokens: 'b', reasoningTokens: null, tier: null, reportedCharge: null })
    console.log(String(calls))
  `
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: root, encoding: 'utf8' })
  return Number(out.trim().split('\n').pop())
}

describe('zod runs without eval', () => {
  it('without the setup module, zod probes eval (control)', () => {
    expect(evalProbes(null)).toBeGreaterThan(0)
  })

  it('the app setup module turns the probe off', () => {
    expect(evalProbes('./src/ui/zodJitless.ts')).toBe(0)
  })

  it('the worker setup module turns the probe off', () => {
    expect(evalProbes('./src/worker/zodJitless.ts')).toBe(0)
  })

  it('both entry points import the setup module before anything else', () => {
    const firstImport = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').split('\n').find((l) => l.startsWith('import '))
    expect(firstImport('src/main.tsx')).toBe("import './ui/zodJitless'")
    expect(firstImport('src/worker/engine.worker.ts')).toBe("import './zodJitless'")
  })
})
