import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { FIXTURES, forceBlobExport, importFixture } from './helpers'

async function expectNoSeriousViolations(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).analyze()
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(serious.map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
}

test('axe finds no serious or critical violations in any area', async ({ page }) => {
  await page.goto('/#/import')
  await expectNoSeriousViolations(page, 'import')
  await importFixture(page, 'd-anthropic-messages.json')
  await expectNoSeriousViolations(page, 'audit')
  await page.getByTestId('row-table').getByRole('row').nth(1).click()
  await expect(page.getByTestId('row-drawer')).toBeVisible()
  await expectNoSeriousViolations(page, 'row drawer')
  await page.keyboard.press('Escape')
  for (const sub of ['benchmark', 'methodology', 'privacy']) {
    await page.goto(`/#/proof/${sub}`)
    await expectNoSeriousViolations(page, `proof ${sub}`)
  }
})

test('keyboard only: import a file, open a row, export', async ({ page }) => {
  await forceBlobExport(page)
  await page.goto('/#/import')
  // Reach the file control with Tab and open the chooser with the keyboard.
  const input = page.getByTestId('file-input')
  let reached = false
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab')
    reached = await input.evaluate((el) => el === document.activeElement)
  }
  expect(reached, 'file control reachable by Tab').toBe(true)
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('Space')
  await (await chooser).setFiles(join(FIXTURES, 'b-openai-responses.json'))
  await expect(page.getByTestId('detected-variant')).toBeVisible()

  await tabTo(page, page.getByTestId('import-button'))
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('coverage-panel')).toBeVisible({ timeout: 60_000 })

  // Open the first row's explanation from the keyboard, then close it with Escape.
  await tabTo(page, page.getByTestId('row-table').locator('[data-row-index="0"]'))
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('row-drawer')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('row-drawer')).toBeHidden()

  await tabTo(page, page.getByTestId('export-csv'))
  const download = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  expect((await download).suggestedFilename()).toMatch(/\.csv$/)
})

async function tabTo(page: Page, target: ReturnType<Page['getByTestId']>) {
  for (let i = 0; i < 200; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return
    await page.keyboard.press('Tab')
  }
  throw new Error('target not reachable by Tab')
}
