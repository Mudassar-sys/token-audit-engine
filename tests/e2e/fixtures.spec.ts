import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PricingManifest, PricingSnapshot, type AuditRow, type AuditSummary } from '../../src/engine/contracts'
import { detectFromSample } from '../../src/engine/detect'
import { runImport } from '../../src/engine/pipeline'
import { FIXTURES, autoFixtures, forceBlobExport, importFixture } from './helpers'

const PUBLIC = join(process.cwd(), 'public', 'pricing')
const manifest = PricingManifest.parse(JSON.parse(readFileSync(join(PUBLIC, 'manifest.json'), 'utf8')))
const latest = manifest.snapshots.find((s) => s.file === manifest.latest)!
const snapshot = PricingSnapshot.parse(JSON.parse(readFileSync(join(PUBLIC, latest.file), 'utf8')))

/** The same engine, run in Node, gives the numbers the UI must show. */
async function expected(file: string): Promise<AuditSummary> {
  const bytes = readFileSync(join(FIXTURES, file))
  const detection = detectFromSample(bytes.subarray(0, 65536).toString('utf8'), file)
  const rows: AuditRow[] = []
  return runImport({
    file: new Blob([bytes]),
    fileName: file,
    variant: detection.variant!,
    detection,
    overridden: false,
    mapping: null,
    snapshot,
    snapshotMeta: { file: latest.file, date: latest.date, sha256: latest.sha256, commit: latest.commit, sourceUrl: latest.sourceUrl },
    signal: new AbortController().signal,
    sink: { write: async (r) => void rows.push(...r) },
    onProgress: () => {},
  })
}

// Any export in these tests downloads through the fallback, never a save dialog.
test.beforeEach(async ({ page }) => {
  await forceBlobExport(page)
})

for (const file of autoFixtures()) {
  test(`imports ${file} and renders its labels and totals`, async ({ page }) => {
    const want = await expected(file)
    await importFixture(page, file)
    await expect(page.getByTestId('detected-variant')).toContainText(want.variant)
    const coverage = page.getByTestId('coverage-panel')
    await expect(coverage).toContainText(`${want.coverage.totalRows.toLocaleString('en-US')}`)
    await expect(coverage.getByTestId('cov-priced')).toContainText(want.coverage.rowsPriced.toLocaleString('en-US'))
    await expect(coverage.getByTestId('cov-not-priced')).toContainText(want.coverage.rowsNotPriced.toLocaleString('en-US'))
    await expect(coverage.getByTestId('cov-unresolved')).toContainText(want.coverage.rowsUnresolved.toLocaleString('en-US'))
    await expect(page.getByTestId('totals')).toContainText(want.totals.value.displayUsd)
    if (want.totals.partial) await expect(page.getByTestId('partial-total')).toBeVisible()
    else await expect(page.getByTestId('partial-total')).toHaveCount(0)
    await expect(page.getByTestId('price-label')).toContainText(`current list price, snapshot ${latest.date}`)
  })
}

test('the three zero cases render as $0 with source, Not priced and Unresolved', async ({ page }) => {
  await importFixture(page, 'zero-valid-explicit-rate.json')
  await expect(page.getByTestId('row-table')).toContainText('$0.000000')
  await importFixture(page, 'zero-valid-reported-charge.jsonl')
  await expect(page.getByTestId('row-table')).toContainText('Measured charge')
  await importFixture(page, 'zero-not-priced.jsonl')
  await expect(page.getByTestId('row-table')).toContainText('Not priced')
  await importFixture(page, 'zero-unresolved.json')
  await expect(page.getByTestId('row-table')).toContainText('Unresolved')
})

test('custom CSV goes through the mapping step with a 20 row preview', async ({ page }) => {
  const mapping = JSON.parse(readFileSync(join(FIXTURES, 'h-custom-mapping.json'), 'utf8')) as Record<string, unknown>
  await page.goto('/#/import')
  await page.getByTestId('file-input').setInputFiles(join(FIXTURES, 'h-custom.csv'))
  await expect(page.getByTestId('detected-variant')).toContainText('H-csv')
  const panel = page.getByTestId('mapping-panel')
  await expect(panel).toBeVisible()
  for (const [field, column] of Object.entries(mapping)) {
    const control = panel.getByTestId(`map-${field}`)
    if (typeof column === 'string') await control.selectOption(column)
    else if (typeof column === 'boolean') await control.setChecked(column)
  }
  await expect(panel.getByTestId('mapping-preview').locator('tbody tr')).toHaveCount(20)
  await panel.getByTestId('save-mapping').click()
  await page.getByTestId('import-button').click()
  await expect(page.getByTestId('coverage-panel')).toBeVisible()
})
