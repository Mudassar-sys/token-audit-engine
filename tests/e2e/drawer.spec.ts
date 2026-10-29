import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import type { Report } from '../../src/engine/contracts'
import { ENGINE_VERSION } from '../../src/engine/contracts'
import { ENGINE_FINGERPRINT } from '../../src/engine/fingerprint.generated'
import { forceBlobExport, importFixture } from './helpers'

async function openRow(page: Page, row: ReturnType<Page['locator']>) {
  await row.click()
  await expect(page.getByTestId('row-drawer')).toBeVisible()
}

async function inclusion(page: Page): Promise<[string, string]> {
  const drawer = page.getByTestId('row-drawer')
  return [await drawer.getByTestId('included-row-counts').innerText(), await drawer.getByTestId('included-cost-totals').innerText()]
}

test('an Unresolved row is included in row counts but not in cost totals', async ({ page }) => {
  await importFixture(page, 'zero-unresolved.json')
  const table = page.getByTestId('row-table')
  await openRow(page, table.locator('[data-row-index]', { hasText: 'Unresolved' }).first())
  const drawer = page.getByTestId('row-drawer')
  await expect(drawer).toContainText('Included in row counts')
  await expect(drawer).toContainText('Included in cost totals')
  await expect(drawer).not.toContainText('Counted in totals')
  expect(await inclusion(page)).toEqual(['yes', 'no, Unresolved'])
})

test('a valid $0 row is included in cost totals', async ({ page }) => {
  await importFixture(page, 'zero-valid-explicit-rate.json')
  const table = page.getByTestId('row-table')
  await openRow(page, table.locator('[data-row-index]', { hasText: '$0.000000' }).first())
  expect(await inclusion(page)).toEqual(['yes', 'yes'])
})

test('an aggregate span is in neither row counts nor cost totals', async ({ page }) => {
  await importFixture(page, 'g-otel-spans.json')
  const table = page.getByTestId('row-table')
  await openRow(page, table.locator('[data-row-index]', { hasText: 'not in row counts or cost totals' }).first())
  expect(await inclusion(page)).toEqual(['no, kept only to reconcile other rows', 'no, kept only to reconcile other rows'])
})

test('the JSON report carries the engine version and the build fingerprint in the identity', async ({ page }) => {
  await forceBlobExport(page)
  await importFixture(page, 'a-openai-chat.json')
  const download = page.waitForEvent('download')
  await page.getByTestId('export-json').click()
  const path = join(process.cwd(), 'test-results', 'drawer-report.json')
  await (await download).saveAs(path)
  const report = JSON.parse(readFileSync(path, 'utf8')) as Report
  expect(report.engineVersion).toBe(ENGINE_VERSION)
  expect(report.schemaVersion).toBe(2)
  expect(report.provenance.engineFingerprint).toBe(ENGINE_FINGERPRINT)
  expect(report.calculationIdentity.inputs.engineFingerprint).toBe(ENGINE_FINGERPRINT)
  expect(report.calculationIdentity.inputs.engineVersion).toBe(ENGINE_VERSION)
  await expect(page.getByTestId('calc-identity')).toHaveText(report.calculationIdentity.sha256)
})
