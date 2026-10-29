import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CustomCsvMapping, NormalizedUsageRow, VariantId } from '../../../src/engine/contracts'
import { adapterForVariant } from '../../../src/engine/adapters'
import type { AdapterRow, RawRecord } from '../../../src/engine/adapters/types'
import { sampleRecordsFromText } from '../../../src/engine/detect'

export const FIXTURES = join(process.cwd(), 'fixtures')

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

/** Records of a fixture, read the way the stream reader for the variant reads them. */
export function fixtureRecords(name: string, variant: VariantId): RawRecord[] {
  return sampleRecordsFromText(fixtureText(name), variant, Number.MAX_SAFE_INTEGER, { truncated: false })
}

/** Run an adapter over records the way the pipeline does: file facts first, then push, then finish. */
export function runAdapter(variant: VariantId, records: RawRecord[], mapping: CustomCsvMapping | null = null): AdapterRow[] {
  const adapter = adapterForVariant(variant)
  const fileFacts = adapter.scanFileFacts ? adapter.scanFileFacts(records.slice(0, 5000)) : {}
  const run = adapter.begin({ variant, mapping, fileFacts })
  const rows: AdapterRow[] = []
  for (const r of records) rows.push(...run.push(r))
  rows.push(...run.finish())
  return rows
}

export function withIndex(rows: AdapterRow[]): NormalizedUsageRow[] {
  return rows.map((r, rowIndex) => ({ ...r, rowIndex }))
}

/** The fields compared against fixtures/expected/<file>.json (same shape the other fixture owners use). */
export function expectedView(rows: AdapterRow[]) {
  return rows.map((r) => ({
    tokens: r.tokens,
    notMeasured: r.notMeasured,
    excluded: r.excluded,
    flags: r.flags,
    unresolvedReason: r.unresolvedReason,
    counted: r.counted,
    requests: r.requests,
    tierStated: r.tierStated,
    modelLogged: r.modelLogged,
    reported: r.reported,
  }))
}

/** Read the expected rows. With UPDATE_EXPECTED=1 the file is first written from the actual rows. */
export function expectedFor(name: string, actual: unknown): unknown {
  const path = join(FIXTURES, 'expected', `${name}.json`)
  if (process.env.UPDATE_EXPECTED === '1') writeFileSync(path, JSON.stringify(actual, null, 2) + '\n')
  if (!existsSync(path)) throw new Error(`Missing ${path}; run once with UPDATE_EXPECTED=1 and review it`)
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}
