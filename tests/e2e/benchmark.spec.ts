import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, test, type Page } from '@playwright/test'

// 200 ms is the published good threshold for interaction to next paint. A main-thread task
// longer than that blocks an interaction past it. Shared CI runners are slower than desktops,
// so the budget is the user-facing threshold, not the 50 ms long-task line. Zero long tasks is
// recorded, not asserted.
const LONGEST_TASK_BUDGET_MS = 200
const INTERACTION_BUDGET_MS = 200
/** Real interactions made while the full import runs. */
const INTERACTIONS = 6

type Stats = { count: number; maxMs: number }
type Outcome = { result?: Record<string, unknown>; error?: string }

/** Press Tab and click the page heading (a neutral element) while the full import runs. */
async function interactDuringImport(page: Page): Promise<number> {
  // Wait for the full import, or for the run to stop early (the error is reported by the caller).
  const started = await page.waitForFunction(
    () => {
      const w = window as unknown as { __benchmarkPhase?: string; __benchmarkError?: string }
      return w.__benchmarkError !== undefined ? 'error' : w.__benchmarkPhase === 'full-import' ? 'full-import' : null
    },
    null,
    { timeout: 10 * 60_000, polling: 100 },
  )
  if ((await started.jsonValue()) !== 'full-import') return 0
  const heading = page.getByRole('heading', { name: 'Benchmark', exact: true })
  let done = 0
  for (let i = 0; i < INTERACTIONS; i++) {
    const phase = await page.evaluate(() => (window as unknown as { __benchmarkPhase?: string }).__benchmarkPhase)
    if (phase !== 'full-import') break
    await page.keyboard.press('Tab')
    await heading.click()
    done++
    await page.waitForTimeout(500)
  }
  return done
}

// Generates the 200MB synthetic file, imports it, cancels midway, imports again to completion,
// runs a routing scenario, exports the rows as CSV, and records every field.
// It runs in an on-disk browser profile, as a visitor's browser does: a throwaway profile keeps IndexedDB in memory.
test('200MB benchmark: cancel midway, full import, scenario and export', async ({ baseURL }) => {
  test.setTimeout(40 * 60_000)
  const profile = mkdtempSync(join(tmpdir(), 'bench-profile-'))
  const context = await chromium.launchPersistentContext(profile, { channel: process.env.PW_CHANNEL, baseURL })
  try {
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto('/#/proof/benchmark')
    await page.getByTestId('benchmark-run').click()

    const interacted = await interactDuringImport(page)

    const handle = await page.waitForFunction(
      () => {
        const w = window as unknown as { __benchmarkResult?: unknown; __benchmarkError?: string }
        return w.__benchmarkResult ? { result: w.__benchmarkResult } : w.__benchmarkError ? { error: w.__benchmarkError } : null
      },
      null,
      { timeout: 30 * 60_000, polling: 2000 },
    )
    const outcome = (await handle.jsonValue()) as Outcome
    expect(outcome.error, 'benchmark error').toBeUndefined()
    expect(interacted, 'interactions made during the full import').toBeGreaterThanOrEqual(5)
    const result = outcome.result!

    // One line in the CI log carries every number.
    console.log(`BENCHMARK_RESULT ${JSON.stringify(result)}`)
    const outDir = join(process.cwd(), 'test-results')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, `benchmark-${process.env.BENCH_LABEL ?? 'local'}.json`), JSON.stringify(result, null, 2))

    for (const field of [
      'recordedAt', 'cpuCores', 'memoryClass', 'browser', 'seed', 'fileSha256', 'fileBytes', 'rows', 'columns', 'sourceMix',
      'snapshotFile', 'snapshotSha256', 'totalMs', 'rowsPerSecond', 'importedRows', 'expectedNotPriced', 'expectedUnresolved',
      'rowsNotPriced', 'rowsUnresolved', 'peakMemory', 'cancelMs', 'rowsAfterCancel', 'longTasks', 'interactions',
      'scenarioMs', 'scenarioRows', 'exportPath', 'exportBytes', 'exportMs', 'exportPeakMemory', 'exportedRows',
    ]) {
      expect(result, `benchmark field ${field}`).toHaveProperty(field)
    }
    expect(result.fileBytes).toBe(209_715_200)
    expect(result.fileSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Number(result.rows)).toBeGreaterThan(100_000)
    expect(Number(result.cancelMs)).toBeGreaterThanOrEqual(0)

    expect(result.importedRows, 'imported rows equal generated rows').toBe(result.rows)
    expect(result.rowsAfterCancel, 'rows of the cancelled import left in storage').toBe(0)
    expect(result.rowsNotPriced, 'Not priced rows equal the rows written to be Not priced').toBe(result.expectedNotPriced)
    expect(result.rowsUnresolved, 'Unresolved rows equal the rows written to be Unresolved').toBe(result.expectedUnresolved)
    expect(result.scenarioRows, 'scenario read every row').toBe(result.importedRows)
    expect(result.exportPath).toBe('stream')
    expect(result.exportedRows, 'rows read back from the export').toBe(result.importedRows)

    const longTasks = result.longTasks as Stats | string
    expect(typeof longTasks, 'long task timing available').toBe('object')
    expect((longTasks as Stats).maxMs, 'longest main-thread task during the full import').toBeLessThanOrEqual(LONGEST_TASK_BUDGET_MS)
    const interactions = result.interactions as Stats | string
    expect(typeof interactions, 'event timing available').toBe('object')
    expect((interactions as Stats).maxMs, 'longest interaction to next paint during the full import').toBeLessThanOrEqual(INTERACTION_BUDGET_MS)

    await expect(page.getByTestId('benchmark-results')).toContainText('rows per second')
  } finally {
    await context.close()
    rmSync(profile, { recursive: true, force: true })
  }
})
