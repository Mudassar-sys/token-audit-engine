import type { AggregateBucket, AuditRow, AuditSummary, Coverage } from './contracts'
import { femtoToExactUsd, formatUsd, usdToFemto } from './money'

export const DEFAULT_AGGREGATE_KEY_CAP = 5000
export const OVERFLOW_KEY = '(overflow)'
export const NO_MODEL_KEY = '(no model)'
export const NO_PROVIDER_KEY = '(no provider)'
export const NO_TIME_KEY = '(no time)'
export const INPUT_BANDS = ['<1k', '1k-10k', '10k-100k', '>=100k'] as const
export type InputBand = (typeof INPUT_BANDS)[number]

export type AggregatorSummary = Pick<AuditSummary, 'coverage' | 'totals' | 'aggregates' | 'bands' | 'excludedFromCost'>

/** Input band of a total input token count per request. */
export function inputBand(inputPerRequest: number): InputBand {
  if (inputPerRequest < 1000) return '<1k'
  if (inputPerRequest < 10000) return '1k-10k'
  if (inputPerRequest < 100000) return '10k-100k'
  return '>=100k'
}

function writeSum(row: AuditRow): number {
  const w = row.tokens.cacheWrite
  return w['5m'] + w['1h'] + w['30m'] + w['12h']
}

/** Total input per request: uncached + cache read + all writes. Time buckets divide by requests. */
export function inputPerRequest(row: AuditRow): number {
  const total = row.tokens.uncachedInput + row.tokens.cacheRead + writeSum(row)
  if (row.granularity === 'time_bucket') return row.requests > 0 ? total / row.requests : total
  return total
}

interface Bucket {
  rows: number
  requests: number
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  value: bigint
  rowsNotPriced: number
  rowsUnresolved: number
}

interface BandBucket {
  model: string
  resolvedKey: string | null
  band: string
  priced: boolean
  requests: number
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  value: bigint
}

/**
 * A dimension map that stops adding new keys at the cap and folds the rest into an overflow key
 * ('(overflow)' unless the caller passes a more specific one).
 */
class CappedMap<V> {
  readonly map = new Map<string, V>()
  private readonly overflowKeys = new Set<string>()
  overflowed = false
  constructor(
    private readonly cap: number,
    private readonly create: (overflow: boolean, key: string) => V,
  ) {}

  get(key: string, overflowKey: string = OVERFLOW_KEY): V {
    let v = this.map.get(key)
    if (v) return v
    let k = key
    const overflow = this.map.size - this.overflowKeys.size >= this.cap && !this.overflowKeys.has(key)
    if (overflow) {
      this.overflowed = true
      k = overflowKey
      v = this.map.get(k)
      if (v) return v
      this.overflowKeys.add(k)
    }
    v = this.create(overflow, k)
    this.map.set(k, v)
    return v
  }
}

const PRICED_SUFFIX = '\u00001'
const bandKey = (model: string, band: string, priced: boolean) => `${model}\u0000${band}${priced ? PRICED_SUFFIX : '\u00000'}`

const newBucket = (): Bucket => ({
  rows: 0,
  requests: 0,
  uncachedInput: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  value: 0n,
  rowsNotPriced: 0,
  rowsUnresolved: 0,
})

function pluralRows(n: number): string {
  return `${n} ${n === 1 ? 'row' : 'rows'}`
}

/**
 * Streaming aggregation over priced rows. Holds only bounded per-key sums,
 * so memory does not grow with the number of rows.
 */
export class Aggregator {
  private readonly cov: Coverage = {
    totalRows: 0,
    countedRows: 0,
    rowsWithProviderUsage: 0,
    rowsPriced: 0,
    rowsNotPriced: 0,
    rowsUnresolved: 0,
    rowsMalformed: 0,
  }
  private value = 0n
  private measuredCharge = 0n
  private estimated = 0n
  private readonly byModel: CappedMap<Bucket>
  private readonly byProvider: CappedMap<Bucket>
  private readonly byDay: CappedMap<Bucket>
  private readonly byLabel: CappedMap<Bucket>
  private readonly bands: CappedMap<BandBucket>
  private readonly excluded = new Map<string, number>()

  constructor(
    readonly cap = DEFAULT_AGGREGATE_KEY_CAP,
    private readonly displayDecimals = 6,
  ) {
    if (!Number.isInteger(cap) || cap < 1) throw new Error(`Aggregate key cap must be a positive integer, got ${cap}`)
    this.byModel = new CappedMap(cap, newBucket)
    this.byProvider = new CappedMap(cap, newBucket)
    this.byDay = new CappedMap(cap, newBucket)
    this.byLabel = new CappedMap(cap, newBucket)
    // One key per model, band and priced state; the cap counts keys. Past the cap, priced and
    // unpriced rows fold into two separate overflow bands so each keeps its true priced state.
    this.bands = new CappedMap(cap, (overflow, key) => ({
      model: overflow ? OVERFLOW_KEY : '',
      resolvedKey: null,
      band: overflow ? OVERFLOW_KEY : '',
      priced: key.endsWith(PRICED_SUFFIX),
      requests: 0,
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      value: 0n,
    }))
  }

  add(row: AuditRow): void {
    const c = this.cov
    c.totalRows++
    const malformed = row.flags.includes('malformed')
    if (malformed) c.rowsMalformed++
    if (!row.counted) return

    c.countedRows++
    if (!malformed) c.rowsWithProviderUsage++
    const kind = row.cost.label.kind
    const femto = row.cost.valueUsd === null ? null : usdToFemto(row.cost.valueUsd)
    if (femto !== null) {
      c.rowsPriced++
      this.value += femto
      if (kind === 'Measured charge') this.measuredCharge += femto
      else if (kind === 'Estimated') this.estimated += femto
    } else if (kind === 'Unresolved') {
      c.rowsUnresolved++
    } else {
      c.rowsNotPriced++
    }

    const model = row.modelLogged ?? NO_MODEL_KEY
    this.addTo(this.byModel.get(model), row, femto, kind)
    this.addTo(this.byProvider.get(row.provider ?? NO_PROVIDER_KEY), row, femto, kind)
    this.addTo(this.byDay.get(row.timestamp ? row.timestamp.slice(0, 10) : NO_TIME_KEY), row, femto, kind)
    this.addTo(this.byLabel.get(kind), row, femto, kind)

    for (const [k, v] of Object.entries(row.excluded)) {
      if (typeof v === 'number' && Number.isFinite(v)) this.excluded.set(k, (this.excluded.get(k) ?? 0) + v)
    }

    const band = inputBand(inputPerRequest(row))
    const priced = femto !== null
    const b = this.bands.get(bandKey(model, band, priced), bandKey(OVERFLOW_KEY, OVERFLOW_KEY, priced))
    if (b.band === '') {
      b.model = model
      b.band = band
      b.resolvedKey = row.resolvedKey
    }
    b.requests += row.requests
    b.uncachedInput += row.tokens.uncachedInput
    b.cacheRead += row.tokens.cacheRead
    b.cacheWrite += writeSum(row)
    b.output += row.tokens.output
    if (femto !== null) b.value += femto
  }

  private addTo(b: Bucket, row: AuditRow, femto: bigint | null, kind: string): void {
    b.rows++
    b.requests += row.requests
    b.uncachedInput += row.tokens.uncachedInput
    b.cacheRead += row.tokens.cacheRead
    b.cacheWrite += writeSum(row)
    b.output += row.tokens.output
    b.reasoning += row.tokens.reasoning ?? 0
    if (femto !== null) b.value += femto
    else if (kind === 'Unresolved') b.rowsUnresolved++
    else b.rowsNotPriced++
  }

  get overflowed(): boolean {
    return (
      this.byModel.overflowed ||
      this.byProvider.overflowed ||
      this.byDay.overflowed ||
      this.byLabel.overflowed ||
      this.bands.overflowed
    )
  }

  private pair(femto: bigint): { exactUsd: string; displayUsd: string } {
    return { exactUsd: femtoToExactUsd(femto), displayUsd: formatUsd(femto, this.displayDecimals) }
  }

  summary(): AggregatorSummary {
    const c = this.cov
    const left: string[] = []
    if (c.rowsNotPriced) left.push(`${pluralRows(c.rowsNotPriced)} Not priced`)
    if (c.rowsUnresolved) left.push(`${pluralRows(c.rowsUnresolved)} Unresolved`)
    const leftCount = c.rowsNotPriced + c.rowsUnresolved
    const partial = leftCount > 0
    const partialReason = partial ? `${left.join(' and ')} ${leftCount === 1 ? 'is' : 'are'} left out` : null

    // Highest value first; buckets with no value sort after every valued bucket.
    const byValue = (a: AggregateBucket, b: AggregateBucket) => {
      if ((a.valueUsd === null) !== (b.valueUsd === null)) return a.valueUsd === null ? 1 : -1
      const d = (b.valueUsd === null ? 0n : usdToFemto(b.valueUsd)) - (a.valueUsd === null ? 0n : usdToFemto(a.valueUsd))
      if (d !== 0n) return d > 0n ? 1 : -1
      return b.rows - a.rows || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    }
    const byKey = (a: AggregateBucket, b: AggregateBucket) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

    return {
      coverage: { ...c },
      totals: {
        value: this.pair(this.value),
        measuredCharge: this.pair(this.measuredCharge),
        estimated: this.pair(this.estimated),
        partial,
        partialReason,
      },
      aggregates: {
        byModel: buckets(this.byModel).sort(byValue),
        byProvider: buckets(this.byProvider).sort(byValue),
        byDay: buckets(this.byDay).sort(byKey),
        byLabel: buckets(this.byLabel).sort(byValue),
        overflowed: this.overflowed,
      },
      bands: [...this.bands.map.values()]
        .map((b) => ({
          model: b.model,
          resolvedKey: b.resolvedKey,
          band: b.band,
          requests: b.requests,
          uncachedInput: b.uncachedInput,
          cacheRead: b.cacheRead,
          cacheWrite: b.cacheWrite,
          output: b.output,
          valueUsd: femtoToExactUsd(b.value),
          priced: b.priced,
        }))
        .sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : INPUT_BANDS.indexOf(a.band as InputBand) - INPUT_BANDS.indexOf(b.band as InputBand) || Number(b.priced) - Number(a.priced))),
      excludedFromCost: Object.fromEntries([...this.excluded.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    }
  }
}

function buckets(m: CappedMap<Bucket>): AggregateBucket[] {
  return [...m.map.entries()].map(([key, b]) => {
    const left = b.rowsNotPriced + b.rowsUnresolved
    return {
      key,
      rows: b.rows,
      requests: b.requests,
      tokens: {
        uncachedInput: b.uncachedInput,
        cacheRead: b.cacheRead,
        cacheWrite: b.cacheWrite,
        output: b.output,
        reasoning: b.reasoning,
      },
      // No priced row means no value, never a 0 that reads like a valid zero.
      valueUsd: left >= b.rows ? null : femtoToExactUsd(b.value),
      rowsNotPriced: b.rowsNotPriced,
      rowsUnresolved: b.rowsUnresolved,
      partial: left > 0,
    }
  })
}
