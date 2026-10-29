import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, test } from '@playwright/test'

// Generates the 200MB synthetic file, imports it, cancels midway, imports again to completion, and records every field.
// It runs in an on-disk browser profile, as a visitor's browser does: a throwaway profile keeps IndexedDB in memory.
test('200MB benchmark: cancel midway, then full import', async ({ baseURL }) => {
  test.setTimeout(30 * 60_000)
  const profile = mkdtempSync(join(tmpdir(), 'bench-profile-'))
  const context = await chromium.launchPersistentContext(profile, { channel: process.env.PW_CHANNEL, baseURL })
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto('/#/proof/benchmark')
    await page.getByTestId('benchmark-run').click()
    type Outcome = { result?: Record<string, unknown>; error?: string }
    const handle = await page.waitForFunction(
      () => {
        const w = window as unknown as { __benchmarkResult?: unknown; __benchmarkError?: string }
        return w.__benchmarkResult ? { result: w.__benchmarkResult } : w.__benchmarkError ? { error: w.__benchmarkError } : null
      },
      null,
      { timeout: 25 * 60_000, polling: 2000 },
    )
    const outcome = (await handle.jsonValue()) as Outcome
    expect(outcome.error, 'benchmark error').toBeUndefined()
    const result = outcome.result!

    for (const field of [
      'recordedAt', 'cpuCores', 'memoryClass', 'browser', 'fileBytes', 'rows', 'columns', 'sourceMix',
      'totalMs', 'rowsPerSecond', 'peakMemory', 'cancelMs', 'longTasks',
    ]) {
      expect(result, `benchmark field ${field}`).toHaveProperty(field)
    }
    expect(result.fileBytes).toBe(209_715_200)
    expect(Number(result.rows)).toBeGreaterThan(100_000)
    expect(Number(result.cancelMs)).toBeGreaterThanOrEqual(0)

    const outDir = join(process.cwd(), 'test-results')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, `benchmark-${process.env.BENCH_LABEL ?? 'local'}.json`), JSON.stringify(result, null, 2))
    await expect(page.getByTestId('benchmark-results')).toContainText('rows per second')
  } finally {
    await context.close()
    rmSync(profile, { recursive: true, force: true })
  }
})
