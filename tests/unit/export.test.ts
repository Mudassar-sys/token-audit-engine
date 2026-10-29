import Papa from 'papaparse'
import { describe, expect, it } from 'vitest'
import { Aggregator } from '../../src/engine/aggregate'
import { Report, type AuditSummary, type IdentityInputs } from '../../src/engine/contracts'
import { auditRowToCsvLine, buildReport, CSV_COLUMNS, CSV_HEADER, csvEscapeCell } from '../../src/engine/export'
import { calculationIdentity, canonicalJson, sha256Hex } from '../../src/engine/identity'
import { makeAuditRow, TEST_META } from './helpers/testSnapshot'

describe('csvEscapeCell', () => {
  it('neutralizes formula starts', () => {
    expect(csvEscapeCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)")
    expect(csvEscapeCell('+1+1')).toBe("'+1+1")
    expect(csvEscapeCell('-2+3')).toBe("'-2+3")
    expect(csvEscapeCell('@cmd')).toBe("'@cmd")
    expect(csvEscapeCell('\tx')).toBe("'\tx")
    expect(csvEscapeCell('\rx')).toBe(`"'\rx"`)
    expect(csvEscapeCell('a=b')).toBe('a=b')
  })

  it('applies RFC 4180 quoting', () => {
    expect(csvEscapeCell('plain')).toBe('plain')
    expect(csvEscapeCell('a,b')).toBe('"a,b"')
    expect(csvEscapeCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscapeCell('two\nlines')).toBe('"two\nlines"')
    expect(csvEscapeCell('=1,2')).toBe(`"'=1,2"`)
    expect(csvEscapeCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
  })

  it('writes empty cells for null and engine numbers as they are', () => {
    expect(csvEscapeCell(null)).toBe('')
    expect(csvEscapeCell(undefined)).toBe('')
    expect(csvEscapeCell(42)).toBe('42')
    expect(csvEscapeCell(true)).toBe('true')
  })
})

describe('auditRowToCsvLine', () => {
  it('round-trips through a CSV parser with hostile text', () => {
    const row = makeAuditRow({ model: '=cmd|"/c calc"!A1', provider: 'a,b\nc', value: '0.005615' })
    row.unresolvedReason = '@risky'
    const text = CSV_HEADER + auditRowToCsvLine(row)
    expect(text.endsWith('\r\n')).toBe(true)
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true })
    expect(parsed.errors).toEqual([])
    expect(parsed.meta.fields).toEqual([...CSV_COLUMNS])
    const out = parsed.data[0]!
    expect(out.modelLogged).toBe(`'=cmd|"/c calc"!A1`)
    expect(out.provider).toBe('a,b\nc')
    expect(out.valueUsd).toBe('0.005615')
    expect(out.unresolvedReason).toBe("'@risky")
    expect(out.rowIndex).toBe('0')
  })
})

function summaryFor(): AuditSummary {
  const agg = new Aggregator()
  agg.add(makeAuditRow({ rowIndex: 0, value: '0.005615' }))
  agg.add(makeAuditRow({ rowIndex: 1, kind: 'Measured charge', value: '0.00014', model: 'openai/gpt-4o' }))
  agg.add(makeAuditRow({ rowIndex: 2, kind: 'Not priced', model: 'unlisted-model-x' }))
  return {
    auditId: 'audit-1',
    fileName: 'calls.jsonl',
    fileBytes: 1234,
    variant: 'A-jsonl',
    detection: { variant: 'A-jsonl', confidence: 0.9, reason: 'matched', candidates: [], csvHeaders: null },
    overridden: false,
    inputFileSha256: 'e'.repeat(64),
    snapshot: TEST_META,
    ...agg.summary(),
    mapping: null,
    elapsedMs: 10,
    rowsPerSecond: 300,
  }
}

const inputs: IdentityInputs = {
  inputFileSha256: 'e'.repeat(64),
  mapping: null,
  adapters: [{ id: 'openai-chat', version: '1.0.0' }],
  schemaVersion: 1,
  snapshotSha256: TEST_META.sha256,
  baselineModel: 'gpt-4o-mini',
  routing: null,
  priceOverrides: [],
  reportSettings: { displayDecimals: 4, aggregateKeyCap: 5000 },
  engineVersion: '1.0.0',
}

describe('buildReport', () => {
  it('validates against the Report schema and carries exact amounts beside display values', () => {
    const report = buildReport(summaryFor(), inputs, '2026-10-29T12:00:00.000Z', { delta: 5n, note: 'Estimated' })
    expect(() => Report.parse(report)).not.toThrow()
    expect(report.title).toBe('Token cost audit report')
    expect(report.totals.value).toEqual({ exactUsd: '0.005755', displayUsd: '$0.0058' })
    expect(report.totals.estimated).toEqual({ exactUsd: '0.005615', displayUsd: '$0.0056' })
    expect(report.totals.measuredCharge).toEqual({ exactUsd: '0.00014', displayUsd: '$0.0001' })
    expect(report.totals.partial).toBe(true)
    expect(report.provenance.priceLabel).toBe('current list price, snapshot 2026-10-01')
    expect(report.provenance.detection).toEqual({ variant: 'A-jsonl', confidence: 0.9, overridden: false })
    expect(report.savings).toEqual({ delta: '5', note: 'Estimated' })
    expect(report.calculationIdentity.sha256).toBe(calculationIdentity(inputs))
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })

  it('the export time does not change the identity', () => {
    const a = buildReport(summaryFor(), inputs, '2026-10-29T12:00:00.000Z', null)
    const b = buildReport(summaryFor(), inputs, new Date('2027-01-01T00:00:00.000Z'), null)
    expect(a.exportedAt).not.toBe(b.exportedAt)
    expect(a.calculationIdentity.sha256).toBe(b.calculationIdentity.sha256)
    expect(a.savings).toBeNull()
  })

  it('stores the identity inputs in canonical form, so they hash to the stated identity', () => {
    const routing = {
      sourceModels: ['gpt-4o-mini', 'gpt-4o', 'gpt-4o'],
      inputBands: ['>=100k', '<1k'],
      targetModel: 'gpt-4o-mini',
      eligibleShare: '0.50',
      outputLengthRatio: '01',
      tokenizerRatio: '1.0',
      retryFallbackRate: '0.000',
      routingOverheadTokens: 0,
      calibrationPassRate: null,
    }
    const report = buildReport(summaryFor(), { ...inputs, routing }, '2026-10-29T12:00:00.000Z', null)
    expect(report.calculationIdentity.inputs.routing?.sourceModels).toEqual(['gpt-4o', 'gpt-4o-mini'])
    expect(report.calculationIdentity.inputs.routing?.eligibleShare).toBe('0.5')
    expect(sha256Hex(canonicalJson(report.calculationIdentity.inputs))).toBe(report.calculationIdentity.sha256)
  })
})
