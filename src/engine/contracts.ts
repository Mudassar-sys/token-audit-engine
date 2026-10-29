import { z } from 'zod'

export const ENGINE_VERSION = '1.0.0'
export const SCHEMA_VERSION = 1

/** Every supported input variant. Anything else is "not supported yet". */
export const VariantId = z.enum([
  'A-json', // OpenAI Chat Completions responses, JSON array
  'A-jsonl', // OpenAI Chat Completions responses, JSONL
  'B-json', // OpenAI Responses API responses, JSON array
  'B-jsonl', // OpenAI Responses API responses, JSONL
  'C-page', // OpenAI organization Usage API completions page
  'D-json', // Anthropic Messages responses, JSON array
  'D-jsonl', // Anthropic Messages responses, JSONL
  'E-json', // OpenRouter responses with usage accounting, JSON array
  'E-jsonl', // OpenRouter responses with usage accounting, JSONL
  'F-csv', // LiteLLM spend logs, CSV
  'F-json', // LiteLLM spend logs, JSON array
  'G-otlp', // OpenTelemetry GenAI spans, OTLP JSON export request
  'G-otlp-jsonl', // OpenTelemetry GenAI spans, one OTLP JSON export request per line
  'H-csv', // Any other CSV through a column mapping
])
export type VariantId = z.infer<typeof VariantId>

export const SourceId = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])
export type SourceId = z.infer<typeof SourceId>

export const Tier = z.enum(['standard', 'batch', 'flex', 'priority', 'ultrafast'])
export type Tier = z.infer<typeof Tier>

export const CacheDuration = z.enum(['5m', '1h', '30m', '12h'])
export type CacheDuration = z.infer<typeof CacheDuration>

export const Granularity = z.enum(['request', 'time_bucket'])

export const LabelKind = z.enum([
  'Measured',
  'Measured charge',
  'Estimated',
  'Not measured',
  'Not priced',
  'Unresolved',
])
export type LabelKind = z.infer<typeof LabelKind>

/** A label always carries a one-line reason. */
export const Label = z.object({ kind: LabelKind, reason: z.string() })
export type Label = z.infer<typeof Label>

/** Row-level notes that explain an assumption or a check. */
export const Flag = z.enum([
  'tier_assumed',
  'duration_assumed',
  'inclusion_assumed',
  'inclusion_detected',
  'long_context_applied',
  'long_context_not_applied_bucket',
  'totals_disagree',
  'cache_exceeds_input',
  'aggregate_span',
  'overlaps_counted_child',
  'aggregate_mismatch',
  'cost_inconsistent',
  'malformed',
  'model_missing',
])
export type Flag = z.infer<typeof Flag>

/** Integer token count. Absent values are null and labelled Not measured. */
const Tok = z.number().int().nonnegative()

export const TokenClasses = z.object({
  uncachedInput: Tok,
  cacheRead: Tok,
  cacheWrite: z.object({ '5m': Tok, '1h': Tok, '30m': Tok, '12h': Tok }),
  output: Tok,
  /** Reasoning tokens are a breakdown of output. Never added on top. */
  reasoning: Tok.nullable(),
})
export type TokenClasses = z.infer<typeof TokenClasses>

/** Counted but never folded into token cost. */
export const ExcludedUsage = z.record(z.string(), z.number().nonnegative())
export type ExcludedUsage = z.infer<typeof ExcludedUsage>

/** Exact decimal text in USD, for example "0.005615". */
export const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/)

export const ReportedAmount = z.object({
  amountUsd: DecimalString,
  field: z.string(),
  /** charge: authoritative billed amount. gateway_estimate: the gateway's own calculation. */
  kind: z.enum(['charge', 'gateway_estimate']),
})
export type ReportedAmount = z.infer<typeof ReportedAmount>

export const NormalizedUsageRow = z.object({
  rowIndex: z.number().int().nonnegative(),
  timestamp: z.string().nullable(),
  variant: VariantId,
  provider: z.string().nullable(),
  modelLogged: z.string().nullable(),
  /** Tier stated by the row. null means not stated, so standard is assumed. */
  tierStated: Tier.nullable(),
  granularity: Granularity,
  tokens: TokenClasses,
  /** Which token classes were absent in the source (labelled Not measured). */
  notMeasured: z.array(z.string()),
  excluded: ExcludedUsage,
  reported: ReportedAmount.nullable(),
  /** Raw fields read from the source row, as path -> value. */
  raw: z.record(z.string(), z.unknown()),
  /** Human readable description of the mapping used, one line per class. */
  mapping: z.array(z.string()),
  flags: z.array(Flag),
  /** When set the row cannot be costed without review. */
  unresolvedReason: z.string().nullable(),
  /** false for rows kept only to reconcile children (aggregate spans). */
  counted: z.boolean(),
  /** Request count represented by the row (1 for request rows). */
  requests: z.number().int().nonnegative(),
})
export type NormalizedUsageRow = z.infer<typeof NormalizedUsageRow>

export const RateKey = z.string()

export const PricingModelEntry = z.object({
  provider: z.string(),
  mode: z.string().nullable(),
  /** Registry rate key -> exact original decimal text, USD per token. */
  rates: z.record(RateKey, z.string()),
})
export type PricingModelEntry = z.infer<typeof PricingModelEntry>

export const PricingSnapshot = z.object({
  schemaVersion: z.literal(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.object({
    repository: z.string(),
    path: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    url: z.string().url(),
    fetchedAt: z.string(),
  }),
  keptRateKeyPattern: z.string(),
  models: z.record(z.string(), PricingModelEntry),
  /** Models left out with the reason (for example a rate finer than 1e-15 USD). */
  leftOut: z.array(z.object({ model: z.string(), reason: z.string() })),
})
export type PricingSnapshot = z.infer<typeof PricingSnapshot>

export const ManifestEntry = z.object({
  file: z.string(),
  date: z.string(),
  commit: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceUrl: z.string().url(),
  fetchedAt: z.string(),
  models: z.number().int(),
})
export const PricingManifest = z.object({
  latest: z.string(),
  snapshots: z.array(ManifestEntry),
})
export type PricingManifest = z.infer<typeof PricingManifest>

/** Snapshot frozen into an audit: identity plus content. */
export const FrozenSnapshot = z.object({
  file: z.string(),
  date: z.string(),
  sha256: z.string(),
  commit: z.string(),
})
export type FrozenSnapshot = z.infer<typeof FrozenSnapshot>

export const MatchKind = z.enum(['exact', 'alias', 'none'])

export const AppliedRate = z.object({
  tokenClass: z.string(),
  tokens: z.number().int().nonnegative(),
  rateKey: z.string(),
  rateUsdPerToken: z.string(),
  costUsd: z.string(),
})
export type AppliedRate = z.infer<typeof AppliedRate>

export const CostResult = z.object({
  /** Row value used in totals. null when Not priced or Unresolved. */
  valueUsd: DecimalString.nullable(),
  label: Label,
  /** Tokens times snapshot rate, when computable. */
  estimateUsd: DecimalString.nullable(),
  estimateLabel: Label,
  appliedRates: z.array(AppliedRate),
  formula: z.string(),
})
export type CostResult = z.infer<typeof CostResult>

export const AuditRow = NormalizedUsageRow.extend({
  resolvedKey: z.string().nullable(),
  match: z.object({ kind: MatchKind, detail: z.string(), source: z.string().nullable() }),
  tierApplied: Tier,
  cost: CostResult,
  /** Every value label with its reason, keyed by value name. */
  labels: z.record(z.string(), Label),
  snapshot: FrozenSnapshot,
})
export type AuditRow = z.infer<typeof AuditRow>

export const CustomCsvMapping = z.object({
  timestamp: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  inputTokens: z.string().nullable(),
  /** true when the input column already includes cached tokens. */
  inputIncludesCached: z.boolean(),
  cacheRead: z.string().nullable(),
  cacheWrite: z.string().nullable(),
  cacheWriteDuration: CacheDuration.nullable(),
  outputTokens: z.string().nullable(),
  reasoningTokens: z.string().nullable(),
  tier: z.string().nullable(),
  reportedCharge: z.string().nullable(),
})
export type CustomCsvMapping = z.infer<typeof CustomCsvMapping>

export const RoutingAssumptions = z.object({
  sourceModels: z.array(z.string()),
  inputBands: z.array(z.string()),
  targetModel: z.string().nullable(),
  /** Decimal strings so they hash and compute exactly. */
  eligibleShare: DecimalString,
  outputLengthRatio: DecimalString,
  tokenizerRatio: DecimalString,
  retryFallbackRate: DecimalString,
  routingOverheadTokens: z.number().int().nonnegative(),
  calibrationPassRate: DecimalString.nullable(),
})
export type RoutingAssumptions = z.infer<typeof RoutingAssumptions>

export const PriceOverride = z.object({ model: z.string(), rateKey: z.string(), rateUsdPerToken: DecimalString })

export const ReportSettings = z.object({ displayDecimals: z.number().int().min(2).max(15), aggregateKeyCap: z.number().int().positive() })
export type ReportSettings = z.infer<typeof ReportSettings>

export const IdentityInputs = z.object({
  inputFileSha256: z.string(),
  mapping: CustomCsvMapping.nullable(),
  adapters: z.array(z.object({ id: z.string(), version: z.string() })),
  schemaVersion: z.number().int(),
  snapshotSha256: z.string(),
  baselineModel: z.string().nullable(),
  routing: RoutingAssumptions.nullable(),
  priceOverrides: z.array(PriceOverride),
  reportSettings: ReportSettings,
  engineVersion: z.string(),
})
export type IdentityInputs = z.infer<typeof IdentityInputs>

const AmountPair = z.object({ exactUsd: DecimalString, displayUsd: z.string() })

export const Coverage = z.object({
  totalRows: z.number().int(),
  countedRows: z.number().int(),
  rowsWithProviderUsage: z.number().int(),
  rowsPriced: z.number().int(),
  rowsNotPriced: z.number().int(),
  rowsUnresolved: z.number().int(),
  rowsMalformed: z.number().int(),
})
export type Coverage = z.infer<typeof Coverage>

export const AggregateBucket = z.object({
  key: z.string(),
  rows: z.number().int(),
  requests: z.number().int(),
  tokens: z.object({
    uncachedInput: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    output: z.number(),
    reasoning: z.number(),
  }),
  /** Sum of priced rows. null when no row in the bucket is priced (shown as Not priced, never as 0). */
  valueUsd: DecimalString.nullable(),
  rowsNotPriced: z.number().int(),
  rowsUnresolved: z.number().int(),
  /** true when the bucket leaves out Not priced or Unresolved rows, so its value is a partial total. */
  partial: z.boolean(),
})
export type AggregateBucket = z.infer<typeof AggregateBucket>

export const Report = z.object({
  title: z.literal('Token cost audit report'),
  engineVersion: z.string(),
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
  calculationIdentity: z.object({ sha256: z.string(), inputs: IdentityInputs }),
  provenance: z.object({
    fileName: z.string(),
    fileBytes: z.number().int(),
    variant: VariantId,
    detection: z.object({ variant: VariantId.nullable(), confidence: z.number(), overridden: z.boolean() }),
    snapshot: FrozenSnapshot.extend({ sourceUrl: z.string() }),
    priceLabel: z.string(),
  }),
  coverage: Coverage,
  totals: z.object({
    value: AmountPair,
    measuredCharge: AmountPair,
    estimated: AmountPair,
    partial: z.boolean(),
    partialReason: z.string().nullable(),
  }),
  aggregates: z.object({
    byModel: z.array(AggregateBucket),
    byProvider: z.array(AggregateBucket),
    byDay: z.array(AggregateBucket),
    byLabel: z.array(AggregateBucket),
    overflowed: z.boolean(),
  }),
  excludedFromCost: z.record(z.string(), z.number()),
  savings: z.unknown().nullable(),
})
export type Report = z.infer<typeof Report>

export const Progress = z.object({
  bytesRead: z.number(),
  bytesTotal: z.number(),
  rows: z.number().int(),
  rowsPerSecond: z.number(),
  elapsedMs: z.number(),
})
export type Progress = z.infer<typeof Progress>

export const DetectionResult = z.object({
  variant: VariantId.nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  candidates: z.array(z.object({ variant: VariantId, confidence: z.number() })),
  csvHeaders: z.array(z.string()).nullable(),
})
export type DetectionResult = z.infer<typeof DetectionResult>

/** Summary that the worker sends to the main thread after an import. */
export const AuditSummary = z.object({
  auditId: z.string(),
  fileName: z.string(),
  fileBytes: z.number().int(),
  variant: VariantId,
  detection: DetectionResult,
  overridden: z.boolean(),
  inputFileSha256: z.string(),
  snapshot: FrozenSnapshot.extend({ sourceUrl: z.string() }),
  coverage: Coverage,
  totals: Report.shape.totals,
  aggregates: Report.shape.aggregates,
  /** Token sums by model and input band, used by the savings modeller. */
  bands: z.array(z.object({
    model: z.string(),
    resolvedKey: z.string().nullable(),
    band: z.string(),
    requests: z.number(),
    uncachedInput: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    output: z.number(),
    valueUsd: DecimalString,
    priced: z.boolean(),
  })),
  excludedFromCost: z.record(z.string(), z.number()),
  mapping: CustomCsvMapping.nullable(),
  elapsedMs: z.number(),
  rowsPerSecond: z.number(),
})
export type AuditSummary = z.infer<typeof AuditSummary>

export const WorkerRequest = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detect'), file: z.instanceof(Blob).or(z.any()) }),
  z.object({
    type: z.literal('import'),
    file: z.any(),
    fileName: z.string(),
    variant: VariantId,
    detection: DetectionResult,
    overridden: z.boolean(),
    mapping: CustomCsvMapping.nullable(),
    snapshot: PricingSnapshot,
    snapshotMeta: FrozenSnapshot.extend({ sourceUrl: z.string() }),
  }),
  z.object({ type: z.literal('cancel') }),
  z.object({ type: z.literal('rows'), offset: z.number().int(), limit: z.number().int() }),
  z.object({ type: z.literal('row'), rowIndex: z.number().int() }),
  z.object({ type: z.literal('preview'), file: z.any(), mapping: CustomCsvMapping }),
  z.object({ type: z.literal('exportCsv') }),
  z.object({ type: z.literal('clear') }),
  z.object({ type: z.literal('estimate') }),
  z.object({ type: z.literal('generateSample'), bytes: z.number().int().positive(), seed: z.number().int() }),
])
export type WorkerRequest = z.infer<typeof WorkerRequest>

export const WorkerResponse = z.discriminatedUnion('type', [
  z.object({ type: z.literal('detected'), result: DetectionResult }),
  z.object({ type: z.literal('progress'), progress: Progress }),
  z.object({ type: z.literal('done'), summary: AuditSummary }),
  z.object({
    type: z.literal('cancelled'),
    /** Time from the cancel request until processing stopped and in-flight writes settled. */
    cancelMs: z.number(),
    /** Time spent deleting the partial rows after the stop. */
    deleteMs: z.number(),
    partialRowsDeleted: z.boolean(),
  }),
  z.object({ type: z.literal('error'), message: z.string(), code: z.enum(['quota', 'parse', 'unsupported', 'internal']) }),
  z.object({ type: z.literal('rows'), offset: z.number().int(), rows: z.array(AuditRow) }),
  z.object({ type: z.literal('row'), row: AuditRow.nullable() }),
  z.object({ type: z.literal('preview'), rows: z.array(NormalizedUsageRow), errors: z.array(z.string()) }),
  z.object({ type: z.literal('csv'), blob: z.any(), rows: z.number().int() }),
  z.object({ type: z.literal('cleared') }),
  z.object({ type: z.literal('estimate'), usage: z.number().nullable(), quota: z.number().nullable() }),
  z.object({ type: z.literal('sampleProgress'), bytes: z.number() }),
  z.object({ type: z.literal('sample'), file: z.any(), bytes: z.number(), rows: z.number().int(), columns: z.number().int(), sourceMix: z.record(z.string(), z.number()), ms: z.number() }),
])
export type WorkerResponse = z.infer<typeof WorkerResponse>
