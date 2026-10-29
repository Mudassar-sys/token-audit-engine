/**
 * Records the walkthrough video of a deployed site:
 * generate and import a file, open a row explanation, coverage, a zero case, a savings assumption, privacy, export.
 * Usage: BASE_URL=https://example.test npx tsx scripts/record-walkthrough.ts
 * Writes walkthrough/raw.webm and a JSON timeline of the steps (milliseconds from the start).
 */
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'

const baseURL = process.env.BASE_URL
if (!baseURL) throw new Error('Set BASE_URL')
const out = join(process.cwd(), 'walkthrough')
mkdirSync(out, { recursive: true })

const timeline: { step: string; atMs: number }[] = []
const started = Date.now()
const mark = (step: string) => timeline.push({ step, atMs: Date.now() - started })
const pause = (page: Page, ms: number) => page.waitForTimeout(ms)

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL })
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: out, size: { width: 1280, height: 800 } },
  acceptDownloads: true,
})
const page = await context.newPage()
try {
  await page.goto(`${baseURL}/#/import`)
  mark('open')
  await pause(page, 2500)

  await page.getByTestId('generate-sample').click()
  mark('generate')
  await page.getByTestId('detected-variant').waitFor({ timeout: 300_000 })
  await pause(page, 1500)
  await page.getByTestId('import-button').click()
  mark('import')
  await page.getByTestId('coverage-panel').waitFor({ timeout: 600_000 })
  mark('imported')
  await pause(page, 3000)

  await page.getByTestId('coverage-panel').scrollIntoViewIfNeeded()
  await pause(page, 3500)
  mark('coverage')

  await page.getByTestId('row-table').scrollIntoViewIfNeeded()
  await page.getByTestId('row-table').locator('[data-row-index="0"]').click()
  await page.getByTestId('row-drawer').waitFor()
  mark('drawer')
  await pause(page, 6000)
  await page.keyboard.press('Escape')

  // A zero case: a row whose value is Unresolved or a valid zero.
  const zero = page.getByTestId('row-table').getByText(/Unresolved|\$0\.000000/).first()
  if (await zero.count()) {
    await zero.scrollIntoViewIfNeeded()
    await zero.click()
    await page.getByTestId('row-drawer').waitFor()
    mark('zero-case')
    await pause(page, 5000)
    await page.keyboard.press('Escape')
  }

  await page.getByTestId('savings-panel').scrollIntoViewIfNeeded()
  mark('savings')
  await pause(page, 2000)
  const share = page.getByTestId('savings-panel').getByLabel(/eligible share/i)
  if (await share.count()) {
    await share.fill('0.5')
    await pause(page, 3500)
  }

  await page.getByTestId('export-csv').scrollIntoViewIfNeeded()
  const csv = page.waitForEvent('download')
  await page.getByTestId('export-csv').click()
  await csv
  const json = page.waitForEvent('download')
  await page.getByTestId('export-json').click()
  await json
  mark('export')
  await pause(page, 2500)

  await page.goto(`${baseURL}/#/proof/privacy`)
  await page.getByTestId('privacy-panel').waitFor()
  mark('privacy')
  await pause(page, 5000)
  mark('end')
} finally {
  await context.close()
  await browser.close()
}

const video = readdirSync(out).find((f) => f.endsWith('.webm') && f !== 'raw.webm')
if (video) renameSync(join(out, video), join(out, 'raw.webm'))
writeFileSync(join(out, 'timeline.json'), JSON.stringify(timeline, null, 2))
console.log(JSON.stringify(timeline))
