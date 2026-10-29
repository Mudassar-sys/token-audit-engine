import type {
  AuditRow,
  CacheDuration,
  DurationMap,
  Flag,
  Label,
  NormalizedUsageRow,
  PricingModelEntry,
  RoutingAssumptions,
  ScenarioRequest,
  ScenarioResult,
  Tier,
} from './contracts'
import { inputBand, inputPerRequest } from './aggregate'
import { decimalToScaled, FEMTO_DIGITS, formatUsd, femtoToExactUsd, scaledToDecimal, usdToFemto } from './money'
import { contextThresholds, createPricingEngine, providerFamily, THRESHOLD_ONLY_INPUT_KEYS, TIER_SUFFIX } from './pricing'

/**
 * Savings modeller. Every compared row is repriced through the same row pricer and snapshot as the
 * audit: once as logged (list price), and once moved to the baseline or target model under
 * user-supplied assumptions. Everything here is Estimated and quality is never verified.
 */

const RATIO_DIGITS = 6
const S = 10n ** BigInt(RATIO_DIGITS)
const S2 = S * S
const S3 = S2 * S
/** Display decimals for savings amounts. Only the display value is rounded. */
const DISPLAY_DECIMALS = 6
/**
 * A routing scenario row is a femto amount times three ratios of 6 decimal places each
 * (eligible share, retry and fallback rate, calibration pass rate), so routing amounts are exact
 * at 10^-(15 + 18) USD. They are kept at that scale and never rounded.
 */
export const ROUTING_SCALE_DIGITS = FEMTO_DIGITS + 3 * RATIO_DIGITS

export const BASELINE_LABEL = 'Modelled: the baseline never ran'
export const ASSUMPTION_LABEL = 'user-supplied assumption'
export const LOGGED_VERSUS_LIST_LABEL = 'logged charges versus list price'
export const TIME_BUCKET_ASSUMPTION = 'time-bucket rows have no request sizes: priced at base rates, long-context result uncertain'

/** Reasons a row is left out of every comparison. */
export const LEFT_OUT = {
  notCounted: 'not included in row counts (aggregate span kept only to reconcile other rows)',
  malformed: 'malformed',
  unresolved: 'Unresolved',
  noListPrice: 'no list price',
  estimateIncomplete: 'token estimate incomplete',
} as const
const LEFT_OUT_ORDER = [LEFT_OUT.notCounted, LEFT_OUT.malformed, LEFT_OUT.unresolved, LEFT_OUT.noListPrice, LEFT_OUT.estimateIncomplete]

/** Flags that price() adds. They are dropped before a row is priced again. */
const PRICING_FLAGS: ReadonlySet<Flag> = new Set<Flag>([
  'tier_assumed',
  'long_context_applied',
  'long_context_not_applied_bucket',
  'model_missing',
  'cost_inconsistent',
  'estimate_incomplete',
  'billed_class_missing',
])
/** Fields an AuditRow adds to the normalized row. */
const AUDIT_ONLY_KEYS = ['resolvedKey', 'match', 'tierApplied', 'cost', 'labels', 'snapshot'] as const satisfies readonly Exclude<keyof AuditRow, keyof NormalizedUsageRow>[]
/** price() appends this mapping line for long context sizes; it is dropped before a reprice too. */
const CONTEXT_LINE_PREFIX = 'contextSize = '

const DURATIONS: readonly CacheDuration[] = ['5m', '1h', '30m', '12h']
/** Distinct Not priced reasons kept per side; the rest count as other reasons. */
const REASON_CAP = 20

export type AmountPair = ScenarioResult['listOriginal']

export class SavingsInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SavingsInputError'
  }
}

/** Divide and round half away from zero. */
function divRound(num: bigint, den: bigint): bigint {
  const neg = num < 0n
  const a = neg ? -num : num
  let q = a / den
  if ((a % den) * 2n >= den) q += 1n
  return neg ? -q : q
}

function pair(femto: bigint): AmountPair {
  return { exactUsd: femtoToExactUsd(femto), displayUsd: formatUsd(femto, DISPLAY_DECIMALS) }
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

/**
 * The normalized row behind an audit row: AuditRow-only fields and the flags pricing adds are
 * removed, so pricing it again is a clean re-run of the same code.
 */
export function toNormalized(row: AuditRow): NormalizedUsageRow {
  const rest: Partial<AuditRow> = { ...row }
  for (const k of AUDIT_ONLY_KEYS) delete rest[k]
  return {
    ...(rest as NormalizedUsageRow),
    flags: row.flags.filter((f) => !PRICING_FLAGS.has(f)),
    mapping: row.mapping.filter((m) => !m.startsWith(CONTEXT_LINE_PREFIX)),
  }
}

export interface TransformOptions {
  /** Effective snapshot models, used for provider families and tier keys. */
  models: Readonly<Record<string, PricingModelEntry>>
  /** Ratios scaled by 10^6: 1 is 1000000. */
  tokenizerRatio: bigint
  outputLengthRatio: bigint
  /** Tokens added to uncached input per request (routing only; 0 for the baseline). */
  overheadTokens: bigint
  durationMap: DurationMap
}

export interface TransformedRow {
  row: NormalizedUsageRow
  /** The stated tier has no input and output rates on the target, so it was dropped (tier assumed). */
  tierDropped: boolean
  /** Cache-write durations were mapped to another provider family through the duration map. */
  durationsMapped: boolean
}

/** n x r / den, rounded half up to a whole token count. */
function scaleTokens(n: number, r: bigint, den: bigint): number {
  const v = Number(divRound(BigInt(n) * r, den))
  if (!Number.isSafeInteger(v)) throw new SavingsInputError('a scaled token count is too large; lower the ratios')
  return v
}

function hasTierRates(entry: PricingModelEntry | undefined, tier: Tier): boolean {
  if (!entry) return false
  const suffix = TIER_SUFFIX[tier]
  return entry.rates[`input_cost_per_token${suffix}`] !== undefined && entry.rates[`output_cost_per_token${suffix}`] !== undefined
}

/**
 * The row as it would look on another model: model set to the target key, token classes scaled
 * by the ratios and rounded per class, routing overhead added, cache-write durations mapped across
 * provider families, tier kept or dropped. Long context is left to price(), per request.
 */
export function transformRow(row: AuditRow, targetKey: string, o: TransformOptions): TransformedRow {
  const base = toNormalized(row)
  const t = row.tokens
  const tok = o.tokenizerRatio
  const out = o.outputLengthRatio * o.tokenizerRatio

  const uncachedInput = scaleTokens(t.uncachedInput, tok, S) + Number(o.overheadTokens * BigInt(row.requests))
  if (!Number.isSafeInteger(uncachedInput)) throw new SavingsInputError('routing overhead tokens are too large')
  const cacheRead = scaleTokens(t.cacheRead, tok, S)
  const output = scaleTokens(t.output, out, S2)
  const reasoning = t.reasoning === null ? null : Math.min(scaleTokens(t.reasoning, out, S2), output)

  const sourceEntry = row.resolvedKey === null ? undefined : o.models[row.resolvedKey]
  const targetEntry = o.models[targetKey]
  const sourceFamily = row.resolvedKey !== null && sourceEntry ? providerFamily(row.resolvedKey, sourceEntry) : null
  const targetFamily = targetEntry ? providerFamily(targetKey, targetEntry) : null
  const crossFamily = sourceFamily !== targetFamily
  const cacheWrite: Record<CacheDuration, number> = { '5m': 0, '1h': 0, '30m': 0, '12h': 0 }
  let durationsMapped = false
  for (const d of DURATIONS) {
    const n = scaleTokens(t.cacheWrite[d], tok, S)
    if (n === 0) continue
    const to = crossFamily ? o.durationMap[d] : d
    if (to !== d) durationsMapped = true
    cacheWrite[to] += n
  }

  // Excluded input modalities are never priced but count toward the long context threshold.
  const excluded = { ...base.excluded }
  for (const k of THRESHOLD_ONLY_INPUT_KEYS) {
    const v = excluded[k]
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) excluded[k] = scaleTokens(v, tok, S)
  }

  let tierStated = row.tierStated
  let tierDropped = false
  if (tierStated !== null && targetKey !== row.resolvedKey && !hasTierRates(targetEntry, tierStated)) {
    tierStated = null
    tierDropped = true
  }

  return {
    row: {
      ...base,
      modelLogged: targetKey,
      tierStated,
      tokens: { uncachedInput, cacheRead, cacheWrite, output, reasoning },
      excluded,
      reported: null,
      unresolvedReason: null,
    },
    tierDropped,
    durationsMapped,
  }
}

/** Bounded count of reasons. */
class Reasons {
  private readonly counts = new Map<string, number>()
  add(reason: string): void {
    const k = this.counts.has(reason) || this.counts.size < REASON_CAP ? reason : 'other reasons'
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1)
  }
  text(): string {
    return [...this.counts.entries()]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, n]) => `${k} (${n} ${n === 1 ? 'row' : 'rows'})`)
      .join('; ')
  }
}

function rowsText(n: number): string {
  return `${n} ${n === 1 ? 'row' : 'rows'}`
}

export interface ScenarioRun {
  /** Price a batch of audit rows into the running sums. Memory does not grow with rows. */
  add(rows: readonly AuditRow[]): void
  result(elapsedMs: number): ScenarioResult
}

interface Side {
  tierDropped: number
  durationsMapped: number
}

/**
 * Baseline and routing scenario over audit rows, fed in batches.
 * One pricing engine prices every row: the list price as logged, the baseline and the target.
 */
export function createScenario(req: ScenarioRequest): ScenarioRun {
  const engine = createPricingEngine(req.snapshot, req.snapshotMeta)
  const models = engine.models
  const durationMap = req.durationMap
  const neutral: TransformOptions = { models, tokenizerRatio: S, outputLengthRatio: S, overheadTokens: 0n, durationMap }

  const baselineKey = req.baselineKey
  if (baselineKey !== null && !Object.hasOwn(models, baselineKey)) throw new SavingsInputError(`Baseline model "${baselineKey}" is not in the snapshot`)

  const a = req.routing === null ? null : canonicalRoutingAssumptions(req.routing)
  let targetKey: string | null = null
  let share = 0n
  let retry = 0n
  let pass: bigint | null = null
  let routingOpts: TransformOptions | null = null
  let sourceModels = new Set<string>()
  let inputBands = new Set<string>()
  if (a !== null) {
    if (a.targetModel === null) throw new SavingsInputError('Choose a target model')
    if (!Object.hasOwn(models, a.targetModel)) throw new SavingsInputError(`Target model "${a.targetModel}" is not in the snapshot`)
    targetKey = a.targetModel
    share = ratio(a.eligibleShare, 'Eligible share', S)
    const outRatio = ratio(a.outputLengthRatio, 'Output length ratio', null)
    const tokRatio = ratio(a.tokenizerRatio, 'Tokenizer ratio', null)
    retry = ratio(a.retryFallbackRate, 'Retry and fallback rate', null)
    pass = a.calibrationPassRate === null ? null : ratio(a.calibrationPassRate, 'Calibration pass rate', S)
    if (!Number.isSafeInteger(a.routingOverheadTokens) || a.routingOverheadTokens < 0) {
      throw new SavingsInputError('Routing overhead tokens must be a non-negative whole number')
    }
    routingOpts = { models, tokenizerRatio: tokRatio, outputLengthRatio: outRatio, overheadTokens: BigInt(a.routingOverheadTokens), durationMap }
    sourceModels = new Set(a.sourceModels)
    inputBands = new Set(a.inputBands)
  }

  const thresholdCache = new Map<string, boolean>()
  const hasLongContext = (key: string | null): boolean => {
    if (key === null) return false
    let v = thresholdCache.get(key)
    if (v === undefined) {
      const entry = models[key]
      v = entry !== undefined && contextThresholds(entry).length > 0
      thresholdCache.set(key, v)
    }
    return v
  }

  let rowsRead = 0
  let rowsCompared = 0
  const leftOut = new Map<string, number>()
  let listOriginal = 0n
  let timeBucketRows = 0
  let longContextUncertain = false
  const lvl = { rows: 0, logged: 0n, list: 0n }

  const base = { value: 0n, compared: 0n, priced: 0, notPriced: 0, reasons: new Reasons() }
  const baseSide: Side = { tierDropped: 0, durationsMapped: 0 }
  /** Routing scenario scaled by 10^ROUTING_SCALE_DIGITS - 15 (S^3 on femto). Never rounded. */
  let scenario3 = 0n
  let eligibleRows = 0
  let fallbackRows = 0
  const fallbackReasons = new Reasons()
  const routeSide: Side = { tierDropped: 0, durationsMapped: 0 }

  function leave(reason: string): void {
    leftOut.set(reason, (leftOut.get(reason) ?? 0) + 1)
  }

  function priceAt(row: AuditRow, key: string, o: TransformOptions, side: Side): AuditRow {
    const t = transformRow(row, key, o)
    if (t.tierDropped) side.tierDropped++
    if (t.durationsMapped) side.durationsMapped++
    return engine.price(t.row)
  }

  function addRow(row: AuditRow): void {
    rowsRead++
    if (!row.counted) return leave(LEFT_OUT.notCounted)
    if (row.flags.includes('malformed')) return leave(LEFT_OUT.malformed)
    if (row.flags.includes('estimate_incomplete')) return leave(LEFT_OUT.estimateIncomplete)
    if (row.cost.label.kind === 'Unresolved') return leave(LEFT_OUT.unresolved)

    // List price of the row as logged: the same snapshot and code, with any reported amount set aside.
    const orig = engine.price({ ...toNormalized(row), reported: null })
    if (orig.flags.includes('billed_class_missing')) return leave(LEFT_OUT.estimateIncomplete)
    if (orig.cost.estimateUsd === null) return leave(LEFT_OUT.noListPrice)
    const origF = usdToFemto(orig.cost.estimateUsd)
    rowsCompared++
    listOriginal += origF

    if (row.cost.label.kind === 'Measured charge' && row.cost.valueUsd !== null) {
      lvl.rows++
      lvl.logged += usdToFemto(row.cost.valueUsd)
      lvl.list += origF
    }

    const eligible =
      targetKey !== null &&
      (sourceModels.size === 0 || (row.modelLogged !== null && sourceModels.has(row.modelLogged))) &&
      (inputBands.size === 0 || inputBands.has(inputBand(inputPerRequest(row))))

    if (row.granularity === 'time_bucket') {
      timeBucketRows++
      if (hasLongContext(orig.resolvedKey) || hasLongContext(baselineKey) || (eligible && hasLongContext(targetKey))) longContextUncertain = true
    }

    if (baselineKey !== null) {
      const b = priceAt(orig, baselineKey, neutral, baseSide)
      if (b.cost.estimateUsd === null) {
        base.notPriced++
        base.reasons.add(b.cost.estimateLabel.reason)
      } else {
        base.priced++
        base.value += usdToFemto(b.cost.estimateUsd)
        base.compared += origF
      }
    }

    if (targetKey === null || routingOpts === null) return
    if (!eligible) {
      scenario3 += origF * S3
      return
    }
    eligibleRows++
    const tr = priceAt(orig, targetKey, routingOpts, routeSide)
    if (tr.cost.estimateUsd === null) {
      // The target has no rate for this row, so it keeps its original list price.
      fallbackRows++
      fallbackReasons.add(tr.cost.estimateLabel.reason)
      scenario3 += origF * S3
      return
    }
    const target = usdToFemto(tr.cost.estimateUsd)
    // (1 - share) x orig + share x [(1 + retry) x target + (1 - pass) x orig], at scale S^3.
    scenario3 += (S - share) * origF * S2
    scenario3 += share * (S + retry) * target * S
    if (pass !== null) scenario3 += share * (S - pass) * origF * S
  }

  function sideNotes(side: Side, key: string): string[] {
    const notes: string[] = []
    if (side.tierDropped > 0) {
      notes.push(`${rowsText(side.tierDropped)} stated a tier that ${key} has no input and output rates for, so standard is assumed (tier assumed)`)
    }
    if (side.durationsMapped > 0) {
      notes.push(`${rowsText(side.durationsMapped)} moved to another provider family, so their cache-write durations follow the duration map (${ASSUMPTION_LABEL})`)
    }
    return notes
  }

  function assumptions(): string[] {
    const out: string[] = []
    if (baselineKey !== null) out.push(`baseline model ${baselineKey}: ${ASSUMPTION_LABEL}; the same token counts are assumed on it`)
    if (a !== null) {
      out.push(`target model ${a.targetModel}: ${ASSUMPTION_LABEL}`)
      out.push(`source models ${a.sourceModels.length ? a.sourceModels.join(', ') : 'all'}: ${ASSUMPTION_LABEL}`)
      out.push(`input bands ${a.inputBands.length ? a.inputBands.join(', ') : 'all'}: ${ASSUMPTION_LABEL}`)
      out.push(`eligible share ${a.eligibleShare}: ${ASSUMPTION_LABEL}`)
      out.push(`output length ratio ${a.outputLengthRatio}: ${ASSUMPTION_LABEL}`)
      out.push(`tokenizer ratio ${a.tokenizerRatio}: ${ASSUMPTION_LABEL}`)
      out.push(`retry and fallback rate ${a.retryFallbackRate}: ${ASSUMPTION_LABEL}`)
      out.push(`routing overhead ${a.routingOverheadTokens} tokens per request, added to uncached input: ${ASSUMPTION_LABEL}`)
      out.push(
        a.calibrationPassRate === null
          ? 'no calibration pass rate set, so no fallback cost is added'
          : `calibration pass rate ${a.calibrationPassRate}: ${ASSUMPTION_LABEL}; the failing share also pays the original cost`,
      )
    }
    const map = DURATIONS.map((d) => `${d} to ${durationMap[d]}`).join(', ')
    out.push(`cache-write duration map when tokens move to another provider family: ${map}: ${ASSUMPTION_LABEL}; within the same family durations are kept`)
    out.push('each row is priced by the same pricing code and snapshot as the audit, per request, so long context rates apply when a scaled request crosses a threshold')
    out.push('token counts times a ratio are rounded half up to whole tokens, per class and per row, from the exact value; a ratio of 1 leaves them unchanged; reasoning is capped at output')
    out.push(`a stated tier is kept when the target model has input and output rates for it; otherwise standard is assumed (tier assumed)`)
    if (a !== null) {
      out.push(
        `scenario and savings are exact decimals at 1e-${ROUTING_SCALE_DIGITS} USD (1e-15 USD times three ratios of up to ${RATIO_DIGITS} decimal places); only the display value is rounded, half away from zero, to ${DISPLAY_DECIMALS} decimal places`,
      )
    }
    if (timeBucketRows > 0) out.push(TIME_BUCKET_ASSUMPTION)
    if (lvl.rows > 0) out.push('logged charges are compared with list price on their own line and are never included in savings')
    out.push('quality on the baseline and target models is unverified')
    return out
  }

  function result(elapsedMs: number): ScenarioResult {
    const rowsLeftOut = LEFT_OUT_ORDER.filter((r) => leftOut.has(r)).map((reason) => ({ reason, rows: leftOut.get(reason)! }))
    const label: Label = { kind: 'Estimated', reason: `logged tokens repriced at list prices of snapshot ${req.snapshotMeta.date} under ${ASSUMPTION_LABEL}s` }

    const baseline: ScenarioResult['baseline'] =
      baselineKey === null
        ? null
        : {
            key: baselineKey,
            label: BASELINE_LABEL,
            value: pair(base.value),
            difference: pair(base.value - base.compared),
            comparedOriginal: pair(base.compared),
            rowsPriced: base.priced,
            rowsNotPriced: base.notPriced,
            notes: [
              ...(base.notPriced > 0 ? [`${rowsText(base.notPriced)} cannot be priced at ${baselineKey} and are left out of both sides: ${base.reasons.text()}`] : []),
              ...sideNotes(baseSide, baselineKey),
            ],
          }

    const routing: ScenarioResult['routing'] =
      targetKey === null
        ? null
        : {
            targetKey,
            eligibleRows,
            targetRateFallbackRows: fallbackRows,
            scenario: scaledPair(scenario3),
            savings: scaledPair(listOriginal * S3 - scenario3),
            notes: [
              ...(fallbackRows > 0
                ? [`${fallbackRows} eligible rows kept their original cost because the target has no rate for them: ${fallbackReasons.text()}`]
                : []),
              ...sideNotes(routeSide, targetKey),
            ],
          }

    return {
      label,
      quality: 'unverified',
      snapshot: { file: req.snapshotMeta.file, date: req.snapshotMeta.date, sha256: req.snapshotMeta.sha256, commit: req.snapshotMeta.commit },
      rowsRead,
      rowsCompared,
      rowsLeftOut,
      listOriginal: pair(listOriginal),
      baseline,
      routing,
      loggedVersusList:
        lvl.rows === 0
          ? null
          : { label: LOGGED_VERSUS_LIST_LABEL, rows: lvl.rows, logged: pair(lvl.logged), list: pair(lvl.list), difference: pair(lvl.logged - lvl.list) },
      timeBucketRows,
      longContextUncertain,
      assumptions: assumptions(),
      durationMap: { ...durationMap },
      elapsedMs,
    }
  }

  return {
    add(rows) {
      for (const r of rows) addRow(r)
    },
    result,
  }
}
