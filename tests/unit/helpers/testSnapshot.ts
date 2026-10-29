import type { AuditRow, FrozenSnapshot, Label, LabelKind, PricingSnapshot, VariantId } from '../../../src/engine/contracts'

/** Small hand-made pricing snapshot for unit tests. Rates are decimal text, USD per token. */
export const TEST_SNAPSHOT: PricingSnapshot = {
  schemaVersion: 1,
  date: '2026-10-01',
  source: {
    repository: 'BerriAI/litellm',
    path: 'model_prices_and_context_window.json',
    commit: '0123456789abcdef0123456789abcdef01234567',
    url: 'https://raw.githubusercontent.com/BerriAI/litellm/0123456789abcdef0123456789abcdef01234567/model_prices_and_context_window.json',
    fetchedAt: '2026-10-01T00:00:00.000Z',
  },
  keptRateKeyPattern:
    '^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost|output_cost_per_reasoning_token)(_above_1hr|_above_12hr)?(_above_\\d+k_tokens)?(_batches|_flex|_priority|_ultrafast)?$',
  models: {
    'gpt-4o': {
      provider: 'openai',
      mode: 'chat',
      rates: {
        input_cost_per_token: '0.0000025',
        output_cost_per_token: '0.00001',
        cache_read_input_token_cost: '0.00000125',
        input_cost_per_token_batches: '0.00000125',
        output_cost_per_token_batches: '0.000005',
      },
    },
    'gpt-4o-mini': {
      provider: 'openai',
      mode: 'chat',
      rates: {
        input_cost_per_token: '1.5e-7',
        output_cost_per_token: '6e-7',
        cache_read_input_token_cost: '7.5e-8',
      },
    },
    'gpt-6.1-sol': {
      provider: 'openai',
      mode: 'responses',
      rates: {
        input_cost_per_token: '0.000002',
        output_cost_per_token: '0.00001',
        cache_read_input_token_cost: '1e-7',
        cache_creation_input_token_cost: '0.0000025',
        cache_creation_input_token_cost_above_12hr: '0.000005',
      },
    },
    'claude-sonnet-4-5-20250929': {
      provider: 'anthropic',
      mode: 'chat',
      rates: {
        input_cost_per_token: '0.000003',
        output_cost_per_token: '0.000015',
        cache_read_input_token_cost: '3e-7',
        cache_creation_input_token_cost: '0.00000375',
        cache_creation_input_token_cost_above_1hr: '0.000006',
      },
    },
    'claude-haiku-4-5': {
      provider: 'anthropic',
      mode: 'chat',
      rates: {
        input_cost_per_token: '0.000001',
        output_cost_per_token: '0.000005',
        cache_read_input_token_cost: '1e-7',
        cache_creation_input_token_cost: '0.00000125',
        cache_creation_input_token_cost_above_1hr: '0.000002',
      },
    },
    'gemini-2.5-flash': {
      provider: 'vertex_ai-language-models',
      mode: 'chat',
      rates: {
        input_cost_per_token: '3e-7',
        output_cost_per_token: '0.0000025',
        cache_read_input_token_cost: '3e-8',
        output_cost_per_reasoning_token: '0.0000025',
      },
    },
    'codestral/codestral-latest': {
      provider: 'codestral',
      mode: 'chat',
      rates: { input_cost_per_token: '0', output_cost_per_token: '0' },
    },
  },
  leftOut: [],
}

export const TEST_META: FrozenSnapshot & { sourceUrl: string } = {
  file: '2026-10-01-abcdef12.json',
  date: '2026-10-01',
  sha256: 'abcdef12'.padEnd(64, '0'),
  commit: TEST_SNAPSHOT.source.commit,
  sourceUrl: TEST_SNAPSHOT.source.url,
}

const LABEL_REASON: Record<LabelKind, string> = {
  Measured: 'as logged in usage',
  'Measured charge': 'as logged in usage.cost',
  Estimated: 'tokens times snapshot rate',
  'Not measured': 'absent in source',
  'Not priced': 'model not in snapshot',
  Unresolved: 'review needed',
}

export interface RowSpec {
  rowIndex?: number
  model?: string | null
  provider?: string | null
  timestamp?: string | null
  kind?: LabelKind
  value?: string | null
  estimate?: string | null
  uncached?: number
  cacheRead?: number
  write5m?: number
  output?: number
  reasoning?: number | null
  requests?: number
  granularity?: 'request' | 'time_bucket'
  counted?: boolean
  malformed?: boolean
  excluded?: Record<string, number>
  variant?: VariantId
}

/** Build an AuditRow directly, without adapters or pricing. */
export function makeAuditRow(s: RowSpec = {}): AuditRow {
  const kind = s.kind ?? 'Estimated'
  const value = s.value === undefined ? (kind === 'Not priced' || kind === 'Unresolved' ? null : '0.001') : s.value
  const label: Label = { kind, reason: LABEL_REASON[kind] }
  return {
    rowIndex: s.rowIndex ?? 0,
    timestamp: s.timestamp === undefined ? '2026-09-02T10:00:00.000Z' : s.timestamp,
    variant: s.variant ?? 'A-jsonl',
    provider: s.provider === undefined ? 'openai' : s.provider,
    modelLogged: s.model === undefined ? 'gpt-4o' : s.model,
    tierStated: null,
    granularity: s.granularity ?? 'request',
    tokens: {
      uncachedInput: s.uncached ?? 100,
      cacheRead: s.cacheRead ?? 0,
      cacheWrite: { '5m': s.write5m ?? 0, '1h': 0, '30m': 0, '12h': 0 },
      output: s.output ?? 10,
      reasoning: s.reasoning ?? null,
    },
    notMeasured: [],
    excluded: s.excluded ?? {},
    reported: kind === 'Measured charge' ? { amountUsd: value ?? '0', field: 'usage.cost', kind: 'charge' } : null,
    raw: { 'usage.prompt_tokens': s.uncached ?? 100 },
    mapping: ['uncachedInput = usage.prompt_tokens'],
    flags: s.malformed ? ['malformed'] : [],
    unresolvedReason: kind === 'Unresolved' ? 'review needed' : null,
    counted: s.counted ?? true,
    requests: s.requests ?? 1,
    resolvedKey: kind === 'Not priced' ? null : (s.model ?? 'gpt-4o'),
    match: { kind: kind === 'Not priced' ? 'none' : 'exact', detail: 'exact key', source: null },
    tierApplied: 'standard',
    cost: {
      valueUsd: value,
      label,
      estimateUsd: s.estimate === undefined ? value : s.estimate,
      estimateLabel: { kind: 'Estimated', reason: 'tokens times snapshot rate' },
      appliedRates: [],
      formula: '',
    },
    labels: { value: label },
    snapshot: { file: TEST_META.file, date: TEST_META.date, sha256: TEST_META.sha256, commit: TEST_META.commit },
  }
}
