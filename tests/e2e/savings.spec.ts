import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Report, ScenarioResult } from '../../src/engine/contracts'
import { forceBlobExport, importFixture } from './helpers'

const MODEL = 'gpt-6.1-sol'

test('routing a model to itself with neutral assumptions saves exactly $0.000000, and the JSON report says the same', async ({ page }) => {
  await forceBlobExport(page)
  await importFixture(page, 'b-openai-responses.json')

  const panel = page.getByTestId('savings-panel')
  await panel.getByTestId(`source-model-${MODEL}`).check()
  await panel.getByTestId('target-model').fill(MODEL)
  // Neutral assumptions are the defaults: ratios 1, retry 0, overhead 0, no calibration pass rate.
  await panel.getByTestId('run-savings').click()

  const savingsCell = panel.getByTestId('routing-savings')
  await expect(savingsCell).toHaveText('$0.000000', { timeout: 60_000 })
  const uiSavings = await savingsCell.innerText()
  const uiScenario = await panel.getByTestId('routing-scenario').innerText()
  const uiList = await panel.getByTestId('list-original').innerText()
  await expect(panel.getByTestId('savings-quality')).toHaveText('unverified')

  const outDir = join(process.cwd(), 'test-results', 'savings-report')
  mkdirSync(outDir, { recursive: true })
  const download = page.waitForEvent('download')
  await page.getByTestId('export-json').click()
  const json = await download
  const path = join(outDir, json.suggestedFilename())
  await json.saveAs(path)
  const report = JSON.parse(readFileSync(path, 'utf8')) as Report & { savings: ScenarioResult }

  expect(report.savings.routing!.savings.displayUsd).toBe('$0.000000')
  expect(report.savings.routing!.savings.displayUsd).toBe(uiSavings)
  expect(report.savings.routing!.scenario.displayUsd).toBe(uiScenario)
  expect(report.savings.listOriginal.displayUsd).toBe(uiList)
  expect(report.savings.routing!.targetKey).toBe(MODEL)
  expect(report.savings.quality).toBe('unverified')
  // The identity records what the scenario used.
  expect(report.calculationIdentity.inputs.routing?.sourceModels).toEqual([MODEL])
  expect(report.calculationIdentity.inputs.routing?.targetModel).toBe(MODEL)
  expect(report.calculationIdentity.inputs.durationMap).toEqual(report.savings.durationMap)
})
