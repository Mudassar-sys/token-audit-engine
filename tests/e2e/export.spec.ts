import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Papa from 'papaparse'
import { expect, test } from '@playwright/test'
import { PricingManifest, PricingSnapshot } from '../../src/engine/contracts'
import { detectFromSample } from '../../src/engine/detect'
import { CSV_COLUMNS } from '../../src/engine/export'
import { runImport } from '../../src/engine/pipeline'
import { FIXTURES, forceBlobExport, importFixture } from './helpers'

const PUBLIC = join(process.cwd(), 'public', 'pricing')
const manifest = PricingManifest.parse(JSON.parse(readFileSync(join(PUBLIC, 'manifest.json'), 'utf8')))
const latest = manifest.snapshots.find((s) => s.file === manifest.latest)!
const snapshot = PricingSnapshot.parse(JSON.parse(readFileSync(join(PUBLIC, latest.file), 'utf8')))

/** A fixture with mixed models, a malformed line and an unknown model. */
const FILE = 'a-openai-chat.jsonl'
const CSV_NAME = 'a-openai-chat-audit-rows.csv'

/** Rows the same engine stores for the fixture, run in Node. */
async function expectedRows(file: string): Promise<number> {
  const bytes = readFileSync(join(FIXTURES, file))
  const detection = detectFromSample(bytes.subarray(0, 65536).toString('utf8'), file)
  const summary = await runImport({
    file: new Blob([bytes]),
    fileName: file,
    variant: detection.variant!,
    detection,
    overridden: false,
    mapping: null,
    snapshot,
    snapshotMeta: { file: latest.file, date: latest.date, sha256: latest.sha256, commit: latest.commit, sourceUrl: latest.sourceUrl },
    signal: new AbortController().signal,
    sink: { write: async () => undefined },
    onProgress: () => {},
  })
  return summary.coverage.totalRows
}

/** Parse the export back, quote-aware, and check the header. Returns the record count. */
function parseExport(text: string): number {
  expect(text.startsWith(`${CSV_COLUMNS.join(',')}\r\n`)).toBe(true)
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: 'greedy' })
  expect(parsed.errors).toEqual([])
  expect(parsed.meta.fields).toEqual([...CSV_COLUMNS])
  // Row indexes run 0..n-1 in order: no row lost or repeated.
  expect(parsed.data.map((r) => Number(r.rowIndex))).toEqual(parsed.data.map((_, i) => i))
  return parsed.data.length
}

test('stream path: the rows stream into the chosen file, with no download', async ({ page }) => {
  // Stand in for the save dialog with a file in the origin private file system.
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (opts: { suggestedName: string }) => {
      const dir = await navigator.storage.getDirectory()
      return dir.getFileHandle(opts.suggestedName, { create: true })
    }
  })
  const want = await expectedRows(FILE)
  await importFixture(page, FILE)
  let downloads = 0
  page.on('download', () => downloads++)
  await page.getByTestId('export-csv').click()
  await expect(page.getByTestId('export-status')).toContainText(`CSV export saved with ${want.toLocaleString('en-US')} rows into the chosen file`)

  const text = await page.evaluate(async (name) => {
    const dir = await navigator.storage.getDirectory()
    const file = await (await dir.getFileHandle(name)).getFile()
    return file.text()
  }, CSV_NAME)
  expect(parseExport(text)).toBe(want)
  expect(downloads).toBe(0)
})

test('fallback path: without a save dialog the file downloads with the same rows', async ({ page }) => {
  await forceBlobExport(page)
  const want = await expectedRows(FILE)
  await importFixture(page, FILE)
  expect(await page.evaluate(() => 'showSaveFilePicker' in window)).toBe(false)

  const download = page.waitForEvent('download')
  await page.getByTestId('export-csv').click()
  const csv = await download
  expect(csv.suggestedFilename()).toBe(CSV_NAME)
  const outDir = join(process.cwd(), 'test-results', 'export-fallback')
  mkdirSync(outDir, { recursive: true })
  const path = join(outDir, csv.suggestedFilename())
  await csv.saveAs(path)
  expect(parseExport(readFileSync(path, 'utf8'))).toBe(want)
  await expect(page.getByTestId('export-status')).toContainText(`CSV export saved with ${want.toLocaleString('en-US')} rows,`)
})

test('closing the save dialog does nothing', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async () => {
      throw new DOMException('The user aborted a request.', 'AbortError')
    }
  })
  await importFixture(page, FILE)
  let downloads = 0
  page.on('download', () => downloads++)
  await page.getByTestId('export-csv').click()
  await page.waitForTimeout(500)
  await expect(page.getByTestId('export-status')).toHaveText('')
  expect(downloads).toBe(0)
})
