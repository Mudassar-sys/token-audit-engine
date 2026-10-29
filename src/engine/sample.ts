import { femtoToExactUsd, rateToFemto, tokensTimesRate } from './money'

/**
 * Deterministic synthetic LiteLLM spend log CSV, for benchmarks and demos.
 * Every value is generated from a seeded PRNG. All text is ASCII, so string length equals bytes.
 */

/** LiteLLM_SpendLogs columns, in schema order. */
export const SAMPLE_COLUMNS = [
  'request_id',
  'call_type',
  'api_key',
  'spend',
  'total_tokens',
  'prompt_tokens',
  'completion_tokens',
  'startTime',
  'endTime',
  'request_duration_ms',
  'completionStartTime',
  'model',
  'model_id',
  'model_group',
  'custom_llm_provider',
  'api_base',
  'user',
  'metadata',
  'cache_hit',
  'cache_key',
  'request_tags',
  'team_id',
  'organization_id',
  'end_user',
  'requester_ip_address',
  'messages',
  'response',
  'session_id',
  'status',
] as const

export const SAMPLE_CHUNK_BYTES = 1024 * 1024
const DAY_MS = 86_400_000
const START_MS = Date.UTC(2026, 8, 1)

export interface SampleStats {
  bytes: number
  rows: number
  columns: number
  /** Rows per custom_llm_provider. */
  sourceMix: Record<string, number>
}

/** mulberry32: small, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type CacheStyle = 'anthropic' | 'openai' | 'none'

interface ModelSpec {
  model: string
  provider: string
  weight: number
  /** USD per token as decimal text: input, output, cache read, cache write. */
  rates: { input: string; output: string; read: string; write: string }
  cache: CacheStyle
  writes: boolean
  reasoning: boolean
}

/** Models in the pricing snapshot, plus two that are not (about 2% of rows). */
const MODELS: readonly ModelSpec[] = [
  { model: 'gpt-4o', provider: 'openai', weight: 24, rates: { input: '0.0000025', output: '0.00001', read: '0.00000125', write: '0' }, cache: 'openai', writes: false, reasoning: false },
  { model: 'gpt-4o-mini', provider: 'openai', weight: 22, rates: { input: '0.00000015', output: '0.0000006', read: '0.000000075', write: '0' }, cache: 'openai', writes: false, reasoning: false },
  { model: 'gpt-6.1-sol', provider: 'openai', weight: 8, rates: { input: '0.000002', output: '0.00001', read: '0.0000001', write: '0.0000025' }, cache: 'openai', writes: true, reasoning: true },
  { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic', weight: 15, rates: { input: '0.000003', output: '0.000015', read: '0.0000003', write: '0.00000375' }, cache: 'anthropic', writes: true, reasoning: false },
  { model: 'claude-haiku-4-5', provider: 'anthropic', weight: 12, rates: { input: '0.000001', output: '0.000005', read: '0.0000001', write: '0.00000125' }, cache: 'anthropic', writes: true, reasoning: false },
  { model: 'gemini-2.5-flash', provider: 'gemini', weight: 9, rates: { input: '0.0000003', output: '0.0000025', read: '0.00000003', write: '0' }, cache: 'openai', writes: false, reasoning: true },
  { model: 'codestral/codestral-latest', provider: 'codestral', weight: 8, rates: { input: '0', output: '0', read: '0', write: '0' }, cache: 'none', writes: false, reasoning: false },
  { model: 'unlisted-model-x', provider: 'openai', weight: 1, rates: { input: '0.000001', output: '0.000004', read: '0', write: '0' }, cache: 'none', writes: false, reasoning: false },
  { model: 'internal-finetune-v3', provider: 'hosted_vllm', weight: 1, rates: { input: '0.0000005', output: '0.0000015', read: '0', write: '0' }, cache: 'none', writes: false, reasoning: false },
]

/** Model ids in the sample that the pricing snapshot does not list. */
export const SAMPLE_UNKNOWN_MODELS = ['unlisted-model-x', 'internal-finetune-v3'] as const

const WEIGHT_TOTAL = MODELS.reduce((s, m) => s + m.weight, 0)

/** Input size bands with weights (per 100) and inclusive token ranges. */
const PROMPT_BANDS = [
  { weight: 45, min: 20, max: 999 },
  { weight: 40, min: 1000, max: 9999 },
  { weight: 13, min: 10000, max: 99999 },
  { weight: 2, min: 100000, max: 180000 },
] as const

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

class RowFactory {
  private readonly rand: () => number
  private readonly apiKeys: string[]
  private readonly users: string[]
  private readonly teams: string[]
  private readonly runId: string
  private index = 0

  constructor(seed: number) {
    this.rand = mulberry32(seed)
    this.runId = this.hex(8)
    this.apiKeys = Array.from({ length: 6 }, () => this.hex(64))
    this.users = Array.from({ length: 40 }, () => `user-${this.hex(4)}`)
    this.teams = Array.from({ length: 5 }, () => `team-${this.hex(4)}`)
  }

  private int(n: number): number {
    return Math.floor(this.rand() * n)
  }

  private between(min: number, max: number): number {
    return min + this.int(max - min + 1)
  }

  private hex(len: number): string {
    let s = ''
    while (s.length < len) s += this.int(0x10000).toString(16).padStart(4, '0')
    return s.slice(0, len)
  }

  private pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)] as T
  }

  private pickModel(): ModelSpec {
    let r = this.int(WEIGHT_TOTAL)
    for (const m of MODELS) {
      if (r < m.weight) return m
      r -= m.weight
    }
    return MODELS[0] as ModelSpec
  }

  private promptTokens(): number {
    let r = this.int(100)
    for (const b of PROMPT_BANDS) {
      if (r < b.weight) return this.between(b.min, b.max)
      r -= b.weight
    }
    return 100
  }

  /** One CSV line (with trailing newline) and its provider. */
  next(): { line: string; provider: string } {
    const i = this.index++
    const m = this.pickModel()
    const prompt = this.promptTokens()
    let read = 0
    let write = 0
    if (m.cache !== 'none' && this.int(100) < 40) read = Math.floor((prompt * this.between(10, 95)) / 100)
    if (m.writes && this.int(100) < 15) write = Math.min(prompt - read, this.between(50, 4000))
    const completion = this.int(100) < 5 ? this.between(1500, 8000) : this.between(5, 1500)
    const reasoning = m.reasoning && this.int(100) < 60 ? Math.floor((completion * this.between(20, 80)) / 100) : null
    const uncached = prompt - read - write

    const zeroSpend = m.rates.input !== '0' && this.int(100) < 1
    let spend = '0'
    if (!zeroSpend) {
      const femto =
        tokensTimesRate(uncached, rateToFemto(m.rates.input)) +
        tokensTimesRate(read, rateToFemto(m.rates.read)) +
        tokensTimesRate(write, rateToFemto(m.writes ? m.rates.write : m.rates.input)) +
        tokensTimesRate(completion, rateToFemto(m.rates.output))
      spend = femtoToExactUsd(femto)
    }

    const usage: Record<string, unknown> = {}
    if (m.cache === 'anthropic') {
      usage.cache_read_input_tokens = read
      usage.cache_creation_input_tokens = write
    } else if (m.cache === 'openai') {
      usage.prompt_tokens_details = m.writes ? { cached_tokens: read, cache_write_tokens: write } : { cached_tokens: read }
    }
    if (reasoning !== null) usage.completion_tokens_details = { reasoning_tokens: reasoning }
    const team = this.pick(this.teams)
    const metadata = JSON.stringify({
      additional_usage_values: usage,
      user_api_key_team_alias: team,
      requester_metadata: { source: 'synthetic-sample' },
    })

    const start = START_MS + this.int(30 * DAY_MS)
    const duration = this.between(200, 30000)
    const firstToken = Math.min(duration, this.between(80, 2500))
    const cells: string[] = [
      `req-${this.runId}-${i.toString(16).padStart(8, '0')}`,
      'acompletion',
      this.pick(this.apiKeys),
      spend,
      String(prompt + completion),
      String(prompt),
      String(completion),
      new Date(start).toISOString(),
      new Date(start + duration).toISOString(),
      String(duration),
      new Date(start + firstToken).toISOString(),
      m.model,
      '',
      m.model,
      m.provider,
      '',
      this.pick(this.users),
      metadata,
      'False',
      '',
      '["sample"]',
      team,
      '',
      '',
      `10.0.${this.int(256)}.${this.int(256)}`,
      '{}',
      '{}',
      `sess-${this.hex(12)}`,
      'success',
    ]
    return { line: `${cells.map(csvCell).join(',')}\n`, provider: m.provider }
  }
}

/**
 * Yield CSV text in chunks of about 1 MiB. The total never exceeds targetBytes and
 * ends on a full row (so it lands exactly on or just under the target).
 * The generator's return value carries the stats.
 */
export function* generateSampleChunks(targetBytes: number, seed: number): Generator<string, SampleStats, void> {
  const header = `${SAMPLE_COLUMNS.join(',')}\n`
  const stats: SampleStats = { bytes: 0, rows: 0, columns: SAMPLE_COLUMNS.length, sourceMix: {} }
  if (targetBytes < header.length) return stats
  const factory = new RowFactory(seed)
  let parts: string[] = [header]
  let partBytes = header.length
  stats.bytes = header.length
  for (;;) {
    const { line, provider } = factory.next()
    if (stats.bytes + line.length > targetBytes) break
    parts.push(line)
    partBytes += line.length
    stats.bytes += line.length
    stats.rows++
    stats.sourceMix[provider] = (stats.sourceMix[provider] ?? 0) + 1
    if (partBytes >= SAMPLE_CHUNK_BYTES) {
      yield parts.join('')
      parts = []
      partBytes = 0
    }
  }
  if (parts.length) yield parts.join('')
  return stats
}
