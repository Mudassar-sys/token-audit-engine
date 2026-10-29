/**
 * Records the walkthrough video of a deployed site:
 * generate and import a file, open a row explanation, coverage, a zero case, a savings assumption, privacy, export.
 * Usage: BASE_URL=https://example.test npx tsx scripts/record-walkthrough.ts
 * Writes walkthrough/raw.webm and a JSON timeline of the steps (milliseconds from the start).
 */
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from '@playwright/test'

const baseURL = process.env.BASE_URL
if (!baseURL) throw new Error('Set BASE_URL')
const out = join(process.cwd(), 'walkthrough')
mkdirSync(out, { recursive: true })

const timeline: { step: string; atMs: number }[] = []
const started = Date.now()
const mark = (step: string) => {
  timeline.push({ step, atMs: Date.now() - started })
  console.log(`${step} at ${Date.now() - started} ms`)
}
const pause = (page: Page, ms: number) => page.waitForTimeout(ms)

// A persistent profile keeps IndexedDB on disk, as a normal browser profile does.
const profile = mkdtempSync(join(tmpdir(), 'walkthrough-profile-'))
const context = await chromium.launchPersistentContext(profile, {
  channel: process.env.PW_CHANNEL,
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: out, size: { width: 1280, height: 800 } },
  acceptDownloads: true,
})
const page = context.pages()[0] ?? (await context.newPage())
try {
  await page.goto(`${baseURL}/#/import`)
  mark('open')
  await pause(page, 2500)

  await page.getByTestId('generate-sample').click()
  mark('generate')
  await page.getByTestId('detected-variant').waitFor({ timeout: 120_000 })
  await pause(page, 1500)
  await page.getByTestId('import-button').click()
  mark('import')
  await page.getByTestId('coverage-panel').waitFor({ timeout: 240_000 })
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

  const savings = page.getByTestId('savings-panel')
  await savings.scrollIntoViewIfNeeded()
  mark('savings')
  await savings.getByLabel('Baseline model', { exact: true }).fill('gpt-4o-mini')
  await savings.getByRole('button', { name: 'Model the baseline' }).click()
  await pause(page, 3500)
  await savings.getByLabel('Target model', { exact: true }).fill('gpt-4o-mini')
  await savings.getByLabel('Eligible share (0 to 1)').fill('0.5')
  await savings.getByLabel('Retry and fallback rate').fill('0.05')
  await savings.getByRole('button', { name: 'Model the routing scenario' }).click()
  await pause(page, 1000)
  await savings.getByRole('button', { name: 'Model the routing scenario' }).scrollIntoViewIfNeeded()
  await page.mouse.wheel(0, 250)
  await pause(page, 5000)

  await page.getByTestId('export-csv').scrollIntoViewIfNeeded()
  mark('export-start')
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
} catch (err) {
  await page.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined)
  throw err
} finally {
  await context.close()
  rmSync(profile, { recursive: true, force: true })
}

const video = readdirSync(out).find((f) => f.endsWith('.webm') && f !== 'raw.webm')
if (video) renameSync(join(out, video), join(out, 'raw.webm'))
writeFileSync(join(out, 'timeline.json'), JSON.stringify(timeline, null, 2))
console.log(JSON.stringify(timeline))
