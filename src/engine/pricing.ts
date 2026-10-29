import type { z } from 'zod'
import type {
  AppliedRate,
  AuditRow,
  CacheDuration,
  CostResult,
  Flag,
  FrozenSnapshot,
  Label,
  NormalizedUsageRow,
  PriceOverride,
  PricingModelEntry,
  PricingSnapshot,
  Tier,
} from './contracts'
import { femtoToExactUsd, PrecisionError, rateToFemto, tokensTimesRate, usdToFemto } from './money'
import { resolveModel, type Resolution } from './resolve'

/**
 * Prices one normalized row against a frozen snapshot.
 * Rate keys are composed as `${class}${ttl}${ctx}${tier}`, matching the registry naming.
 */

export type PriceOverrideInput = z.infer<typeof PriceOverride>

export type RateClass =
  | 'input_cost_per_token'
  | 'output_cost_per_token'
  | 'cache_read_input_token_cost'
  | 'cache_creation_input_token_cost'
  | 'output_cost_per_reasoning_token'

export type TtlSuffix = '' | '_above_1hr' | '_above_12hr'

export const TIER_SUFFIX: Record<Tier, string> = {
  standard: '',
  batch: '_batches',
  flex: '_flex',
  priority: '_priority',
  ultrafast: '_ultrafast',
}

export const KEPT_RATE_KEY_PATTERN =
  '^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost|output_cost_per_reasoning_token)(_above_1hr|_above_12hr)?(_above_\\d+k_tokens)?(_batches|_flex|_priority|_ultrafast)?$'

/** Compose a registry rate key. */
export function rateKey(cls: RateClass, ttl: TtlSuffix = '', ctxThreshold: number | null = null, tier: Tier = 'standard'): string {
  const ctx = ctxThreshold === null ? '' : `_above_${ctxThreshold / 1000}k_tokens`
  return `${cls}${ttl}${ctx}${TIER_SUFFIX[tier]}`
}

export type ProviderFamily = 'anthropic' | 'openai' | 'other'

const ANTHROPIC_PROVIDERS = new Set(['anthropic', 'vertex_ai-anthropic_models'])
const OPENAI_PROVIDERS = new Set(['openai', 'azure', 'azure_ai', 'text-completion-openai'])

/** Registry provider family, which decides how cache-write durations map to rate keys. */
export function providerFamily(key: string, entry: PricingModelEntry): ProviderFamily {
  if (key.includes('claude') || ANTHROPIC_PROVIDERS.has(entry.provider)) return 'anthropic'
  if (OPENAI_PROVIDERS.has(entry.provider)) return 'openai'
  return 'other'
}

/** Long-context thresholds in tokens found in the model's keys, ascending. */
export function contextThresholds(entry: PricingModelEntry): number[] {
  const out = new Set<number>()
  for (const k of Object.keys(entry.rates)) {
    const m = /_above_(\d+)k_tokens/.exec(k)
    if (m) out.add(Number(m[1]) * 1000)
  }
  return [...out].sort((a, b) => a - b)
}

/** The price label shown beside every estimate. */
export function priceLabel(date: string): string {
  return `current list price, snapshot ${date}`
}

const DURATIONS: readonly CacheDuration[] = ['5m', '1h', '30m', '12h']

const ANTHROPIC_TTL: Partial<Record<CacheDuration, TtlSuffix>> = { '5m': '', '1h': '_above_1hr' }
const OPENAI_TTL: Partial<Record<CacheDuration, TtlSuffix>> = { '30m': '', '12h': '_above_12hr' }

/** Format an integer token count with thousands separators. */
export function formatTokens(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

interface Line {
  tokenClass: string
  tokens: number
  cls: RateClass
  ttl: TtlSuffix
}

type Estimate =
  | { ok: true; femto: bigint; applied: AppliedRate[]; formula: string; allZeroRates: boolean; notes: string[]; contextLine: string | null }
  | { ok: false; reason: string; notes: string[] }

export interface PricingEngine {
  price(row: NormalizedUsageRow): AuditRow
  resolve(modelLogged: string | null): Resolution
  /** Effective model entries (snapshot plus overrides). */
  readonly models: Readonly<Record<string, PricingModelEntry>>
  /** Femto-dollar rate for a model key and rate key, or null when absent. */
  rate(modelKey: string, key: string): bigint | null
}

function rawLookup(raw: Record<string, unknown>, name: string): unknown {
  if (Object.hasOwn(raw, name)) return raw[name]
  for (const [k, v] of Object.entries(raw)) {
    if (k.endsWith(`.${name}`)) return v
  }
  return undefined
}

/**
 * A tier stated in the source that has no rate in the snapshot (for example 'scale').
 * The adapters keep it in raw.service_tier and leave tierStated null.
 */
export function unpricedStatedTier(row: NormalizedUsageRow): string | null {
  if (row.tierStated !== null) return null
  const tier = rawLookup(row.raw, 'service_tier')
  return typeof tier === 'string' && tier.toLowerCase() === 'scale' ? 'scale' : null
}

/** Excluded input modalities. They are never priced but count toward the long context threshold. */
export const THRESHOLD_ONLY_INPUT_KEYS = ['input_audio', 'input_image', 'input_video'] as const

/**
 * Full prompt size of a request as the provider counts it for the long context threshold:
 * the priced input classes plus the excluded input modality tokens.
 */
export function contextInputTokens(row: NormalizedUsageRow): { total: number; priced: number; excluded: [string, number][] } {
  const t = row.tokens
  const priced = t.uncachedInput + t.cacheRead + t.cacheWrite['5m'] + t.cacheWrite['1h'] + t.cacheWrite['30m'] + t.cacheWrite['12h']
  const excluded: [string, number][] = []
  for (const k of THRESHOLD_ONLY_INPUT_KEYS) {
    const v = row.excluded[k]
    if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) excluded.push([k, v])
  }
  return { total: excluded.reduce((s, [, v]) => s + v, priced), priced, excluded }
}

/** Premium modes the snapshot has no rate for. Returns a Not priced reason or null. */
function premiumReason(row: NormalizedUsageRow): string | null {
  const tier = rawLookup(row.raw, 'service_tier')
  if (typeof tier === 'string' && tier.toLowerCase() === 'scale') return 'scale tier has no rate in the snapshot'
  const speed = rawLookup(row.raw, 'speed')
  if (typeof speed === 'string' && speed.toLowerCase() === 'fast') return 'fast mode premium is not in the snapshot'
  const geo = rawLookup(row.raw, 'inference_geo')
  if (typeof geo === 'string' && geo !== '' && geo.toLowerCase() !== 'global') {
    return `regional inference premium (inference_geo "${geo}") is not in the snapshot`
  }
  return null
}

function stripMeta(meta: FrozenSnapshot): FrozenSnapshot {
  return { file: meta.file, date: meta.date, sha256: meta.sha256, commit: meta.commit }
}

function pushFlag(flags: Flag[], f: Flag): void {
  if (!flags.includes(f)) flags.push(f)
}

/** Whole-class or sub-class absence in notMeasured. */
function isNotMeasured(row: NormalizedUsageRow, cls: string): boolean {
  return row.notMeasured.some((n) => n === cls || n.startsWith(`${cls}.`) || n.startsWith(`${cls}[`))
}

function mappingFor(row: NormalizedUsageRow, cls: string): string | null {
  const re = new RegExp(`^${cls.replace('.', '\\.')}(\\.[\\w]+)?\\s*=\\s*(.+)$`)
  const parts: string[] = []
  for (const line of row.mapping) {
    const m = re.exec(line.trim())
    if (m) parts.push(m[1] ? `${m[1].slice(1)}: ${m[2]}` : m[2]!)
  }
  return parts.length ? parts.join('; ') : null
}

function tokenLabel(row: NormalizedUsageRow, cls: 'uncachedInput' | 'cacheRead' | 'cacheWrite' | 'output' | 'reasoning'): Label {
  if (cls === 'reasoning' && row.tokens.reasoning === null) return { kind: 'Not measured', reason: 'absent in source' }
  if (isNotMeasured(row, cls)) return { kind: 'Not measured', reason: 'absent in source' }
  const field = mappingFor(row, cls)
  let reason = field ? `as logged in ${field}` : 'as logged in the source row'
  if (cls === 'cacheWrite' && row.flags.includes('duration_assumed')) reason += '; cache duration assumed'
  return { kind: 'Measured', reason }
}

export function createPricingEngine(
  snapshot: PricingSnapshot,
  meta: FrozenSnapshot,
  overrides: readonly PriceOverrideInput[] = [],
): PricingEngine {
  const frozen = stripMeta(meta)
  const date = snapshot.date
  const models: Record<string, PricingModelEntry> = { ...snapshot.models }
  for (const o of overrides) {
    rateToFemto(o.rateUsdPerToken)
    const base = models[o.model] ?? { provider: 'override', mode: null, rates: {} }
    models[o.model] = { ...base, rates: { ...base.rates, [o.rateKey]: o.rateUsdPerToken } }
  }
  const overridden = new Set(overrides.map((o) => `${o.model}\u0000${o.rateKey}`))
  const femtoCache = new Map<string, Map<string, bigint>>()
  const thresholdCache = new Map<string, number[]>()

  function ratesFor(key: string): Map<string, bigint> {
    let m = femtoCache.get(key)
    if (!m) {
      m = new Map()
      const entry = models[key]
      if (entry) for (const [k, v] of Object.entries(entry.rates)) m.set(k, rateToFemto(v))
      femtoCache.set(key, m)
    }
    return m
  }

  function thresholdsFor(key: string): number[] {
    let t = thresholdCache.get(key)
    if (!t) {
      const entry = models[key]
      t = entry ? contextThresholds(entry) : []
      thresholdCache.set(key, t)
    }
    return t
  }

  function rate(modelKey: string, key: string): bigint | null {
    return ratesFor(modelKey).get(key) ?? null
  }

  function estimate(row: NormalizedUsageRow, key: string, tier: Tier, flags: Flag[]): Estimate {
    const notes: string[] = []
    const entry = models[key]!
    const rates = ratesFor(key)
    const premium = premiumReason(row)
    if (premium) return { ok: false, reason: premium, notes }
    const t = row.tokens

    let ctx: number | null = null
    let contextLine: string | null = null
    const thresholds = thresholdsFor(key)
    if (row.granularity === 'request') {
      // The threshold uses the full prompt size: excluded image, audio and video input
      // tokens count toward it, but they stay out of the cost lines.
      const size = contextInputTokens(row)
      for (const th of thresholds) if (size.total > th) ctx = th
      if (thresholds.length > 0 && size.excluded.length > 0) {
        const parts = size.excluded.map(([k, v]) => `${formatTokens(v)} excluded.${k}`).join(' + ')
        contextLine = `contextSize = ${formatTokens(size.priced)} priced input + ${parts} = ${formatTokens(size.total)} tokens (excluded tokens count toward the long context threshold only and are not priced)`
      }
      if (ctx !== null) {
        pushFlag(flags, 'long_context_applied')
        const incl = size.excluded.length ? `, including ${formatTokens(size.total - size.priced)} excluded image, audio or video input tokens counted for the threshold only` : ''
        notes.push(`long context rates above ${formatTokens(ctx)} input tokens (${formatTokens(size.total)} in this request${incl})`)
      }
    } else if (thresholds.length > 0) {
      pushFlag(flags, 'long_context_not_applied_bucket')
      notes.push('time bucket priced at base rates, long context not applied')
    }

    const lines: Line[] = [{ tokenClass: 'uncachedInput', tokens: t.uncachedInput, cls: 'input_cost_per_token', ttl: '' }]
    lines.push({ tokenClass: 'cacheRead', tokens: t.cacheRead, cls: 'cache_read_input_token_cost', ttl: '' })

    const family = providerFamily(key, entry)
    const hasCreation = Object.keys(entry.rates).some((k) => k.startsWith('cache_creation_input_token_cost'))
    for (const d of DURATIONS) {
      const n = t.cacheWrite[d]
      if (n === 0) continue
      if (family === 'anthropic') {
        const ttl = ANTHROPIC_TTL[d]
        if (ttl === undefined) return { ok: false, reason: `a ${d} cache write has no rate for an Anthropic-family model`, notes }
        lines.push({ tokenClass: `cacheWrite.${d}`, tokens: n, cls: 'cache_creation_input_token_cost', ttl })
      } else if (family === 'openai') {
        const ttl = OPENAI_TTL[d]
        if (ttl === undefined) return { ok: false, reason: `a ${d} cache write has no rate for an OpenAI-family model`, notes }
        if (hasCreation) {
          lines.push({ tokenClass: `cacheWrite.${d}`, tokens: n, cls: 'cache_creation_input_token_cost', ttl })
        } else {
          lines.push({ tokenClass: `cacheWrite.${d}`, tokens: n, cls: 'input_cost_per_token', ttl: '' })
          const note = 'cache writes billed at the ordinary input rate (no additional cache-write charge on this model)'
          if (!notes.includes(note)) notes.push(note)
        }
      } else {
        return { ok: false, reason: `cache writes on provider "${entry.provider}" have no documented duration mapping`, notes }
      }
    }

    const reasoning = t.reasoning
    const baseReasoning = rates.get('output_cost_per_reasoning_token')
    if (baseReasoning !== undefined && reasoning !== null) {
      if (reasoning > t.output) return { ok: false, reason: 'reasoning tokens exceed output tokens', notes }
      // Use the reasoning key composed for this tier and context size when the snapshot has it.
      // When it has only the base reasoning rate and that equals the base output rate, reasoning
      // is billed as output, so the composed output rate applies. Otherwise the composed reasoning
      // key is required and its absence makes the row Not priced.
      let reasoningCls: RateClass = 'output_cost_per_reasoning_token'
      const composed = rateKey('output_cost_per_reasoning_token', '', ctx, tier)
      if (reasoning > 0 && !rates.has(composed) && baseReasoning === rates.get('output_cost_per_token')) {
        reasoningCls = 'output_cost_per_token'
        notes.push(`reasoning tokens at the output rate (no ${composed} key; the base reasoning rate equals the base output rate)`)
      } else {
        notes.push('reasoning tokens at the reasoning rate')
      }
      lines.push({ tokenClass: 'output', tokens: t.output - reasoning, cls: 'output_cost_per_token', ttl: '' })
      lines.push({ tokenClass: 'reasoning', tokens: reasoning, cls: reasoningCls, ttl: '' })
    } else {
      lines.push({ tokenClass: 'output', tokens: t.output, cls: 'output_cost_per_token', ttl: '' })
    }

    const applied: AppliedRate[] = []
    const terms: string[] = []
    let total = 0n
    let allZero = true
    for (const line of lines) {
      if (line.tokens === 0) continue
      const k = rateKey(line.cls, line.ttl, ctx, tier)
      const r = rates.get(k)
      if (r === undefined) {
        const why = ctx !== null ? ' (long context)' : tier !== 'standard' ? ` (${tier} tier)` : ''
        return { ok: false, reason: `missing rate key ${k} for ${key}${why}`, notes }
      }
      const cost = tokensTimesRate(line.tokens, r)
      total += cost
      if (r !== 0n) allZero = false
      if (overridden.has(`${key}\u0000${k}`)) notes.push(`override applied to ${k}`)
      applied.push({
        tokenClass: line.tokenClass,
        tokens: line.tokens,
        rateKey: k,
        rateUsdPerToken: femtoToExactUsd(r),
        costUsd: femtoToExactUsd(cost),
      })
      terms.push(`${formatTokens(line.tokens)} x $${femtoToExactUsd(r)}`)
    }
    let formula = terms.length ? `${terms.join(' + ')} = $${femtoToExactUsd(total)}` : 'no billable tokens = $0'
    if (contextLine) formula += `; ${contextLine}`
    return { ok: true, femto: total, applied, formula, allZeroRates: applied.length > 0 && allZero, notes, contextLine }
  }

  function price(row: NormalizedUsageRow): AuditRow {
    const flags: Flag[] = [...row.flags]
    const malformed = flags.includes('malformed')
    const resolution = resolveModel(row.modelLogged, models)
    const tierApplied: Tier = row.tierStated ?? 'standard'
    const unpricedTier = unpricedStatedTier(row)
    const tierAssumed = row.tierStated === null && unpricedTier === null && !malformed
    if (tierAssumed) pushFlag(flags, 'tier_assumed')
    if (row.modelLogged === null && !malformed) pushFlag(flags, 'model_missing')

    let est: Estimate
    if (malformed) est = { ok: false, reason: 'malformed row', notes: [] }
    else if (resolution.key === null) {
      est = { ok: false, reason: row.modelLogged === null ? 'no model name in the row' : `model "${row.modelLogged}" is not in the snapshot`, notes: [] }
    } else est = estimate(row, resolution.key, tierApplied, flags)

    if (tierAssumed) est.notes.unshift('tier assumed standard')
    const noteText = est.notes.length ? `; ${est.notes.join('; ')}` : ''
    const estimateUsd = est.ok ? femtoToExactUsd(est.femto) : null
    const estimateLabel: Label = est.ok
      ? { kind: 'Estimated', reason: `tokens times snapshot rate${noteText}` }
      : { kind: 'Not priced', reason: est.reason }
    const applied = est.ok ? est.applied : []

    let valueUsd: string | null = null
    let label: Label
    let formula = est.ok ? est.formula : `not priced: ${est.reason}`
    let reportedLabel: Label = { kind: 'Not measured', reason: 'absent in source' }
    const rep = row.reported

    if (rep?.kind === 'charge') reportedLabel = { kind: 'Measured charge', reason: `as logged in ${rep.field}` }
    else if (rep?.kind === 'gateway_estimate') reportedLabel = { kind: 'Estimated', reason: `gateway's own calculation (${rep.field})` }

    let repFemto: bigint | null = null
    let repError: string | null = null
    if (rep) {
      try {
        repFemto = usdToFemto(rep.amountUsd)
        if (repFemto < 0n) {
          repError = `${rep.field} is negative`
          repFemto = null
        }
      } catch (e) {
        repError = e instanceof PrecisionError ? `${rep.field} is finer than 1e-15 USD` : `${rep.field} is not a decimal amount`
      }
    }

    if (row.unresolvedReason !== null || malformed) {
      label = { kind: 'Unresolved', reason: row.unresolvedReason ?? 'malformed row' }
      formula = `unresolved: ${label.reason}`
    } else if (rep?.kind === 'charge') {
      if (repFemto === null) {
        label = { kind: 'Unresolved', reason: `${repError ?? 'reported charge unreadable'}; review needed` }
        formula = `unresolved: ${label.reason}`
      } else {
        valueUsd = femtoToExactUsd(repFemto)
        label = {
          kind: 'Measured charge',
          reason: repFemto === 0n ? `as logged in ${rep.field}; a charge of 0 is a valid zero` : `as logged in ${rep.field}`,
        }
        if (est.ok) {
          const diff = repFemto > est.femto ? repFemto - est.femto : est.femto - repFemto
          if (diff * 100n > est.femto) pushFlag(flags, 'cost_inconsistent')
        }
        formula = `${rep.field} = $${valueUsd}${est.ok ? `; estimate ${est.formula}` : ''}`
      }
    } else if (rep?.kind === 'gateway_estimate') {
      if (!est.ok) {
        label = { kind: 'Not priced', reason: est.reason }
      } else if (repFemto === 0n && est.femto > 0n) {
        label = { kind: 'Unresolved', reason: "gateway logged spend 0 but the snapshot rate is not zero; review needed" }
        formula = `unresolved: ${label.reason}; estimate ${est.formula}`
      } else {
        valueUsd = estimateUsd
        label = valueLabelFromEstimate(est)
      }
    } else if (est.ok) {
      valueUsd = estimateUsd
      label = valueLabelFromEstimate(est)
    } else {
      label = { kind: 'Not priced', reason: est.reason }
    }

    const cost: CostResult = { valueUsd, label, estimateUsd, estimateLabel, appliedRates: applied, formula }

    const tierLabel: Label = unpricedTier !== null
      ? { kind: 'Measured', reason: `stated in source: ${unpricedTier}; the snapshot has no rate for this tier` }
      : row.tierStated === null
        ? { kind: 'Estimated', reason: 'tier assumed: standard (not stated in source)' }
        : { kind: 'Measured', reason: `stated in source: ${row.tierStated}` }
    const modelLabel: Label = resolution.key === null
      ? { kind: 'Not priced', reason: resolution.match.detail }
      : { kind: 'Measured', reason: resolution.match.source ? `${resolution.match.detail} (source ${resolution.match.source})` : resolution.match.detail }

    const labels: Record<string, Label> = {
      uncachedInput: tokenLabel(row, 'uncachedInput'),
      cacheRead: tokenLabel(row, 'cacheRead'),
      cacheWrite: tokenLabel(row, 'cacheWrite'),
      output: tokenLabel(row, 'output'),
      reasoning: tokenLabel(row, 'reasoning'),
      reportedCharge: reportedLabel,
      estimate: estimateLabel,
      value: label,
      tier: tierLabel,
      model: modelLabel,
      price: { kind: 'Estimated', reason: priceLabel(date) },
    }

    const mapping = est.ok && est.contextLine ? [...row.mapping, est.contextLine] : row.mapping

    return {
      ...row,
      mapping,
      flags,
      resolvedKey: resolution.key,
      match: resolution.match,
      tierApplied,
      cost,
      labels,
      snapshot: frozen,
    }

    function valueLabelFromEstimate(e: Extract<Estimate, { ok: true }>): Label {
      if (e.femto === 0n && e.allZeroRates) return { kind: 'Estimated', reason: `explicit zero rate in snapshot ${date}` }
      if (e.femto === 0n && e.applied.length === 0) return { kind: 'Estimated', reason: 'no billable tokens in this row' }
      return { kind: 'Estimated', reason: `tokens times snapshot rate${noteText}` }
    }
  }

  return { price, resolve: (m) => resolveModel(m, models), models, rate }
}
