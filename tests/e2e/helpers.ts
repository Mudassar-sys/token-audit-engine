import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'

export const FIXTURES = join(process.cwd(), 'fixtures')

export const MARKERS: Record<string, string> = JSON.parse(readFileSync(join(FIXTURES, 'markers.json'), 'utf8'))

/** Fixture files that import without a mapping step. */
export function autoFixtures(): string[] {
  return readdirSync(FIXTURES)
    .filter((f) => /\.(json|jsonl|csv)$/.test(f))
    .filter((f) => !['markers.json', 'worked-examples.json', 'h-custom-mapping.json'].includes(f))
    .filter((f) => !f.startsWith('h-') && f !== 'edge-missing-columns.csv')
    .sort()
}

export async function openImport(page: Page) {
  await page.goto('/#/import')
  await expect(page.getByTestId('file-input')).toBeAttached()
}

/** Select a fixture, wait for detection, run the import and wait for the audit to show. */
export async function importFixture(page: Page, file: string) {
  await openImport(page)
  await page.getByTestId('file-input').setInputFiles(join(FIXTURES, file))
  await expect(page.getByTestId('detected-variant')).toBeVisible()
  await page.getByTestId('import-button').click()
  await expect(page.getByTestId('coverage-panel')).toBeVisible({ timeout: 60_000 })
}
