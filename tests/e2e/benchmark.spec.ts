import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// Generates the 200MB synthetic file, imports it, cancels midway, imports again to completion, and records every field.
test('200MB benchmark: cancel midway, then full import', async ({ page }) => {
  test.setTimeout(30 * 60_000)
  await page.goto('/#/proof/benchmark')
  await page.getByTestId('benchmark-run').click()
  const handle = await page.waitForFunction(() => (window as unknown as { __benchmarkResult?: unknown }).__benchmarkResult, null, {
    timeout: 28 * 60_000,
    polling: 2000,
  })
  const result = (await handle.jsonValue()) as Record<string, unknown>

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
})
