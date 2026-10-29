import type { AuditSummary, Label, PricingModelEntry, PricingSnapshot, RoutingAssumptions } from './contracts'
import { OVERFLOW_KEY } from './aggregate'
import { decimalToScaled, FEMTO_DIGITS, femtoToExactUsd, formatUsd, rateToFemto, scaledToDecimal, usdToFemto } from './money'
import { providerFamily } from './pricing'

/**
 * Savings modeller. Everything here is Estimated: it reprices logged token sums
 * at snapshot list prices under user-supplied assumptions. Quality is never verified.
 */

export type Band = AuditSummary['bands'][number]

const RATIO_DIGITS = 6
const S = 10n ** BigInt(RATIO_DIGITS)
/** Display decimals for savings amounts. Only the display value is rounded. */
const DISPLAY_DECIMALS = 6
/**
 * Routing results are products of a femto amount and four ratios of 6 decimal places each,
 * so they are exact at 10^-(15 + 24) USD. They are kept at that scale and never rounded.
 */
export const ROUTING_SCALE_DIGITS = FEMTO_DIGITS + 4 * RATIO_DIGITS

export const BASELINE_LABEL = 'Modelled: the baseline never ran'
export const ASSUMPTION_LABEL = 'user-supplied assumption'

export interface AmountPair {
  exactUsd: string
  displayUsd: string
}

export interface SkippedBand {
  model: string
  band: string
  reason: string
}

export interface BaselineResult {
  kind: 'baseline'
  baselineKey: string
  label: Label
  baselineLabel: typeof BASELINE_LABEL
  quality: 'unverified'
  /** Logged value of the priced bands that were repriced. */
  actual: AmountPair
  /** The same tokens at the baseline model's list price. */
  baseline: AmountPair
  /** baseline minus actual. Positive means the logged usage cost less than the baseline would have. */
  difference: AmountPair
  assumptions: string[]
  bandsUsed: number
  skipped: SkippedBand[]
}

export interface RoutingResult {
  kind: 'routing'
  targetKey: string
  label: Label
  quality: 'unverified'
  /** Logged value of all priced bands. */
  original: AmountPair
  /** Modelled value with the eligible share routed to the target. */
  scenario: AmountPair
  /** original minus scenario. Negative when the scenario costs more. */
  savings: AmountPair
  assumptions: string[]
  bandsUsed: number
  bandsEligible: number
  skipped: SkippedBand[]
}

export class SavingsInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SavingsInputError'
  }
}

function pair(femto: bigint): AmountPair {
  return { exactUsd: femtoToExactUsd(femto), displayUsd: formatUsd(femto) }
}

/**
 * Exact pair for a USD amount scaled by 10^ROUTING_SCALE_DIGITS. The exact text keeps every digit;
 * the display value is rounded once, half away from zero, to DISPLAY_DECIMALS.
 */
function scaledPair(v: bigint): AmountPair {
  const drop = 10n ** BigInt(ROUTING_SCALE_DIGITS - DISPLAY_DECIMALS)
  const displayFemto = divRound(v, drop) * 10n ** BigInt(FEMTO_DIGITS - DISPLAY_DECIMALS)
  return { exactUsd: scaledToDecimal(v, ROUTING_SCALE_DIGITS), displayUsd: formatUsd(displayFemto, DISPLAY_DECIMALS) }
}

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/

/** Lossless canonical decimal text: no leading or trailing zeros, so '0.50' and '00.5' read '0.5'. */
export function canonicalDecimal(text: string): string {
  const m = DECIMAL_TEXT.exec(text.trim())
  if (!m) return text
  const int = m[2]!.replace(/^0+(?=\d)/, '')
  const frac = (m[3] ?? '').replace(/0+$/, '')
  const out = frac ? `${int}.${frac}` : int
  return m[1] && out !== '0' ? `-${out}` : out
}

function sortedUnique(list: readonly string[]): string[] {
  return [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Canonical routing assumptions: source models and input bands are sets, so they are
 * deduplicated and sorted; decimal strings are written without redundant zeros.
 * The same calculation then always has the same text and the same calculation identity.
 */
export function canonicalRoutingAssumptions(a: RoutingAssumptions): RoutingAssumptions {
  return {
    ...a,
    sourceModels: sortedUnique(a.sourceModels),
    inputBands: sortedUnique(a.inputBands),
    eligibleShare: canonicalDecimal(a.eligibleShare),
    outputLengthRatio: canonicalDecimal(a.outputLengthRatio),
    tokenizerRatio: canonicalDecimal(a.tokenizerRatio),
    retryFallbackRate: canonicalDecimal(a.retryFallbackRate),
    calibrationPassRate: a.calibrationPassRate === null ? null : canonicalDecimal(a.calibrationPassRate),
  }
}

function int(n: number, what: string): bigint {
  if (!Number.isSafeInteger(n) || n < 0) throw new SavingsInputError(`${what} must be a non-negative whole number`)
  return BigInt(n)
}

/** Divide and round half away from zero. */
function divRound(num: bigint, den: bigint): bigint {
  const neg = num < 0n
  const a = neg ? -num : num
  let q = a / den
  if ((a % den) * 2n >= den) q += 1n
  return neg ? -q : q
}

function ratio(text: string, what: string, max: bigint | null): bigint {
  let v: bigint
  try {
    v = decimalToScaled(text, RATIO_DIGITS)
  } catch {
    throw new SavingsInputError(`${what} must be a decimal with at most ${RATIO_DIGITS} decimal places`)
  }
  if (v < 0n) throw new SavingsInputError(`${what} cannot be negative`)
  if (max !== null && v > max) throw new SavingsInputError(`${what} cannot be above ${scaledToDecimal(max, RATIO_DIGITS)}`)
  return v
}

interface BaseRates {
  input: bigint
  output: bigint
  cacheRead: bigint
  cacheWrite: bigint
  notes: string[]
}

/** Standard-tier base rates of a model, with the stand-ins used for missing cache rates. */
function baseRates(key: string, entry: PricingModelEntry | undefined, role: string): BaseRates {
  if (!entry) throw new SavingsInputError(`${role} model "${key}" is not in the snapshot`)
  const r = entry.rates
  if (r.input_cost_per_token === undefined || r.output_cost_per_token === undefined) {
    throw new SavingsInputError(`${role} model "${key}" has no input or output token rate in the snapshot`)
  }
  const input = rateToFemto(r.input_cost_per_token)
  const output = rateToFemto(r.output_cost_per_token)
  const notes: string[] = [`${role} priced at standard tier base rates, no long context premium`]
  let cacheRead = input
  if (r.cache_read_input_token_cost !== undefined) cacheRead = rateToFemto(r.cache_read_input_token_cost)
  else notes.push(`${role} has no cache read rate, so cache reads are priced as uncached input`)
  let cacheWrite = input
  if (r.cache_creation_input_token_cost !== undefined) {
    cacheWrite = rateToFemto(r.cache_creation_input_token_cost)
    const fam = providerFamily(key, entry)
    const d = fam === 'anthropic' ? '5 minute' : fam === 'openai' ? '30 minute' : 'base'
    notes.push(`${role} cache writes priced at its ${d} write rate (logged write durations are not split per band)`)
  } else {
    notes.push(`${role} has no cache write rate, so cache writes are priced as uncached input`)
  }
  return { input, output, cacheRead, cacheWrite, notes }
}

function bandCost(b: Band, r: BaseRates): bigint {
  return (
    BigInt(b.uncachedInput) * r.input +
    BigInt(b.cacheRead) * r.cacheRead +
    BigInt(b.cacheWrite) * r.cacheWrite +
    BigInt(b.output) * r.output
  )
}

/** Reprice every priced band at the baseline model's list price. */
export function modelBaseline(bands: readonly Band[], snapshot: PricingSnapshot, baselineKey: string): BaselineResult {
  const rates = baseRates(baselineKey, snapshot.models[baselineKey], 'Baseline')
  let actual = 0n
  let baseline = 0n
  let used = 0
  const skipped: SkippedBand[] = []
  for (const b of bands) {
    if (!b.priced) {
      skipped.push({ model: b.model, band: b.band, reason: 'band has rows that are Not priced or Unresolved, so there is no logged value to compare' })
      continue
    }
    actual += usdToFemto(b.valueUsd)
    baseline += bandCost(b, rates)
    used++
  }
  return {
    kind: 'baseline',
    baselineKey,
    label: { kind: 'Estimated', reason: `logged tokens repriced at the list price of ${baselineKey}` },
    baselineLabel: BASELINE_LABEL,
    quality: 'unverified',
    actual: pair(actual),
    baseline: pair(baseline),
    difference: pair(baseline - actual),
    assumptions: [
      ...rates.notes,
      'reasoning tokens are priced as ordinary output',
      'the same token counts are assumed on the baseline model',
    ],
    bandsUsed: used,
    skipped,
  }
}

/**
 * Route an eligible share of the chosen source models and input bands to a target model.
 * Empty sourceModels or inputBands mean all. Result = original cost minus scenario cost.
 */
export function modelRouting(bands: readonly Band[], snapshot: PricingSnapshot, input: RoutingAssumptions): RoutingResult {
  const a = canonicalRoutingAssumptions(input)
  if (a.targetModel === null) throw new SavingsInputError('Choose a target model')
  const targetKey = a.targetModel
  const entry = snapshot.models[targetKey]
  const base = baseRates(targetKey, entry, 'Target')
  const hasRead = entry?.rates.cache_read_input_token_cost !== undefined
  const readRate = hasRead ? base.cacheRead : base.input
  const writeRate = hasRead ? base.cacheWrite : base.input

  const share = ratio(a.eligibleShare, 'Eligible share', S)
  const outRatio = ratio(a.outputLengthRatio, 'Output length ratio', null)
  const tokRatio = ratio(a.tokenizerRatio, 'Tokenizer ratio', null)
  const retry = ratio(a.retryFallbackRate, 'Retry and fallback rate', null)
  const pass = a.calibrationPassRate === null ? null : ratio(a.calibrationPassRate, 'Calibration pass rate', S)
  const overhead = int(a.routingOverheadTokens, 'Routing overhead tokens')

  const models = new Set(a.sourceModels)
  const inBands = new Set(a.inputBands)
  const S2 = S * S
  const S3 = S2 * S
  const S4 = S3 * S

  let original = 0n
  /** Scenario cost scaled by S^4 so every ratio stays exact. It is never rounded. */
  let scenario4 = 0n
  let overflowPriced = false
  let used = 0
  let eligible = 0
  const skipped: SkippedBand[] = []

  for (const b of bands) {
    if (!b.priced) {
      skipped.push({ model: b.model, band: b.band, reason: 'band has rows that are Not priced or Unresolved, so it is left out' })
      continue
    }
    const orig = usdToFemto(b.valueUsd)
    original += orig
    used++
    if (b.model === OVERFLOW_KEY) overflowPriced = true
    const modelMatch = models.size === 0 || models.has(b.model) || (b.resolvedKey !== null && models.has(b.resolvedKey))
    const bandMatch = inBands.size === 0 || inBands.has(b.band)
    if (!modelMatch || !bandMatch) {
      scenario4 += orig * S4
      continue
    }
    eligible++
    // Share that stays on the original model.
    scenario4 += orig * (S - share) * S3
    // Target tokens: input (scale S), cache classes (scale S), output (scale S^2).
    const inTok = BigInt(b.uncachedInput) * tokRatio + overhead * BigInt(b.requests) * S
    const readTok = BigInt(b.cacheRead) * tokRatio
    const writeTok = BigInt(b.cacheWrite) * tokRatio
    const outTok = BigInt(b.output) * outRatio * tokRatio
    const target2 = (inTok * base.input + readTok * readRate + writeTok * writeRate) * S + outTok * base.output
    // Moved share, with retries and fallbacks on top: scale S^4.
    scenario4 += target2 * share * (S + retry)
    // Requests failing calibration also pay the original cost.
    if (pass !== null) scenario4 += orig * share * (S - pass) * S2
  }

  const original4 = original * S4
  const filtered = models.size > 0 || inBands.size > 0
  const assumptions = [
    `eligible share ${a.eligibleShare}, output length ratio ${a.outputLengthRatio}, tokenizer ratio ${a.tokenizerRatio}, retry and fallback rate ${a.retryFallbackRate}, routing overhead ${a.routingOverheadTokens} tokens per request: ${ASSUMPTION_LABEL}`,
    a.calibrationPassRate === null
      ? 'no calibration pass rate set, so no fallback cost is added'
      : `calibration pass rate ${a.calibrationPassRate} (${ASSUMPTION_LABEL}); the failing share also pays the original cost`,
    hasRead
      ? 'target has a cache read rate, so cache reads keep the target cache read rate and writes its base write rate'
      : 'target has no cache read rate, so cache classes are priced as uncached input',
    ...base.notes,
    'reasoning tokens are priced as ordinary output',
    ...(overflowPriced && filtered
      ? [`rows grouped under ${OVERFLOW_KEY} past the key limit match no named source model or input band, so they keep their logged value`]
      : []),
    `scenario and savings are exact decimals at 1e-${ROUTING_SCALE_DIGITS} USD (1e-15 USD times four ratios of up to ${RATIO_DIGITS} decimal places); nothing is rounded except the display value, which is rounded to ${DISPLAY_DECIMALS} decimal places`,
    'quality on the target model is unverified',
  ]
  return {
    kind: 'routing',
    targetKey,
    label: { kind: 'Estimated', reason: `eligible share repriced at the list price of ${targetKey}` },
    quality: 'unverified',
    original: pair(original),
    scenario: scaledPair(scenario4),
    savings: scaledPair(original4 - scenario4),
    assumptions,
    bandsUsed: used,
    bandsEligible: eligible,
    skipped,
  }
}
