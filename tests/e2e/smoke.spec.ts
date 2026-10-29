import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { forceBlobExport, importFixture } from './helpers'

// Smoke suite for a deployed site: run with BASE_URL=<site> npx playwright test --grep @smoke
test('@smoke headers, import a fixture, download both exports', async ({ page, request }) => {
  const res = await request.get('/')
  expect(res.status()).toBe(200)
  expect(res.headers()['content-security-policy']).toContain("connect-src 'self'")
  expect(res.headers()['x-robots-tag']).toBe('noindex')

  await forceBlobExport(page)
  await importFixture(page, 'd-anthropic-messages.json')
  await expect(page.getByTestId('price-label')).toContainText('current list price, snapshot')
  await expect(page.getByTestId('totals')).toContainText('$')

  const outDir = join(process.cwd(), 'test-results', 'smoke-exports')
  mkdirSync(outDir, { recursive: true })
  const csvDownload = page.waitForEvent('download')
  await page.getByTestId('export-csv').click()
  const csv = await csvDownload
  const csvPath = join(outDir, csv.suggestedFilename())
  await csv.saveAs(csvPath)
  expect(readFileSync(csvPath, 'utf8').split('\n')[0]).toContain('rowIndex')

  const jsonDownload = page.waitForEvent('download')
  await page.getByTestId('export-json').click()
  const json = await jsonDownload
  const jsonPath = join(outDir, json.suggestedFilename())
  await json.saveAs(jsonPath)
  const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as { calculationIdentity: { sha256: string }; totals: { value: { exactUsd: string } } }
  expect(report.calculationIdentity.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(report.totals.value.exactUsd).toMatch(/^\d+(\.\d+)?$/)
})
