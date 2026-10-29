import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { NormalizedUsageRow } from '../../src/engine/contracts'
import type { VariantId } from '../../src/engine/contracts'
import type { Adapter, AdapterRow, RawRecord } from '../../src/engine/adapters/types'
import { openaiChatAdapter } from '../../src/engine/adapters/openaiChat'
import { openaiResponsesAdapter } from '../../src/engine/adapters/openaiResponses'
import { openaiUsageAdapter } from '../../src/engine/adapters/openaiUsage'
import { openrouterAdapter, openrouterProvider } from '../../src/engine/adapters/openrouter'

const fixture = (name: string) => new URL(`../../fixtures/${name}`, import.meta.url)
const readText = (name: string) => readFileSync(fixture(name), 'utf8')

/** Parse a fixture into the records a stream reader would hand over. */
function recordsOf(name: string, variant: VariantId): RawRecord[] {
  const text = readText(name)
  if (name.endsWith('.jsonl')) {
    const out: RawRecord[] = []
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.trim() === '') return
      try {
        out.push({ kind: 'json', value: JSON.parse(line) as unknown, line: i + 1 })
      } catch {
        out.push({ kind: 'error', message: 'invalid JSON', raw: line, line: i + 1 })
      }
    })
    return out
  }
  const value = JSON.parse(text) as unknown
  if (variant === 'C-page') return (value as { data: unknown[] }).data.map((b) => ({ kind: 'json', value: b, line: null }))
  return (value as unknown[]).map((v) => ({ kind: 'json', value: v, line: null }))
}

function run(adapter: Adapter, variant: VariantId, records: RawRecord[]): AdapterRow[] {
  const r = adapter.begin({ variant, mapping: null, fileFacts: {} })
  return [...records.flatMap((rec) => r.push(rec)), ...r.finish()]
}

const one = (adapter: Adapter, variant: VariantId, value: unknown): AdapterRow => {
  const rows = run(adapter, variant, [{ kind: 'json', value, line: 1 }])
  expect(rows).toHaveLength(1)
  return rows[0]!
}

function pick(row: AdapterRow) {
  const { tokens, notMeasured, excluded, flags, unresolvedReason, counted, requests, tierStated, modelLogged, reported } = row
  return { tokens, notMeasured, excluded, flags, unresolvedReason, counted, requests, tierStated, modelLogged, reported }
}

type Expected = ReturnType<typeof pick>

const CASES: { file: string; variant: VariantId; adapter: Adapter; provider: (row: AdapterRow) => string | null }[] = [
  { file: 'a-openai-chat.json', variant: 'A-json', adapter: openaiChatAdapter, provider: () => 'openai' },
  { file: 'a-openai-chat.jsonl', variant: 'A-jsonl', adapter: openaiChatAdapter, provider: () => 'openai' },
  { file: 'edge-mixed-models.jsonl', variant: 'A-jsonl', adapter: openaiChatAdapter, provider: () => 'openai' },
  { file: 'zero-not-priced.jsonl', variant: 'A-jsonl', adapter: openaiChatAdapter, provider: () => 'openai' },
  { file: 'b-openai-responses.json', variant: 'B-json', adapter: openaiResponsesAdapter, provider: () => 'openai' },
  { file: 'b-openai-responses.jsonl', variant: 'B-jsonl', adapter: openaiResponsesAdapter, provider: () => 'openai' },
  { file: 'c-openai-usage-page.json', variant: 'C-page', adapter: openaiUsageAdapter, provider: () => 'openai' },
  { file: 'e-openrouter.json', variant: 'E-json', adapter: openrouterAdapter, provider: (r) => openrouterProvider(r.modelLogged) },
  { file: 'e-openrouter.jsonl', variant: 'E-jsonl', adapter: openrouterAdapter, provider: (r) => openrouterProvider(r.modelLogged) },
  { file: 'zero-valid-reported-charge.jsonl', variant: 'E-jsonl', adapter: openrouterAdapter, provider: () => 'meta-llama' },
]

const markers = JSON.parse(readText('markers.json')) as Record<string, string>

describe('fixtures match their expected rows', () => {
  for (const c of CASES) {
    it(c.file, () => {
      const rows = run(c.adapter, c.variant, recordsOf(c.file, c.variant))
      const expected = JSON.parse(readText(`expected/${c.file}.json`)) as Expected[]
      expect(rows).toHaveLength(expected.length)
      rows.forEach((row, i) => {
        const exp = expected[i]!
        const got = pick(row)
        if (exp.flags.includes('malformed')) {
          expect(got.unresolvedReason).toMatch(/^Malformed: /)
          expect({ ...got, unresolvedReason: null }).toEqual({ ...exp, unresolvedReason: null })
          return
        }
        expect(got, `${c.file} row ${i}`).toEqual(exp)
        expect(row.variant).toBe(c.variant)
        expect(row.provider).toBe(c.provider(row))
        expect(row.mapping.length).toBeGreaterThan(0)
        // Raw keeps the fields read, never message content.
        expect(JSON.stringify(row.raw)).not.toContain('Synthetic reply.')
        expect(JSON.stringify(row.raw)).not.toContain('Hello there!')
      })
      for (const [i, row] of rows.entries()) expect(() => NormalizedUsageRow.parse({ ...row, rowIndex: i })).not.toThrow()
    })
  }

  it('every fixture carries its marker, and the marker reaches raw on the first row', () => {
    for (const c of CASES) {
      const marker = markers[c.file]
      expect(marker, c.file).toMatch(/^ZQXMARK-[a-z0-9-]+-[0-9a-f]{8}$/)
      expect(readText(c.file)).toContain(marker)
      const rows = run(c.adapter, c.variant, recordsOf(c.file, c.variant))
      expect(JSON.stringify(rows[0]!.raw)).toContain(marker)
    }
  })
})

describe('documented examples', () => {
  it('chat cached call: 2006 prompt, 1920 cached => 86 uncached, mapping shows the numbers', () => {
    const row = run(openaiChatAdapter, 'A-json', recordsOf('a-openai-chat.json', 'A-json'))[0]!
    expect(row.tokens.uncachedInput).toBe(86)
    expect(row.tokens.cacheRead).toBe(1920)
    expect(row.mapping[0]).toBe('uncachedInput = usage.prompt_tokens (2006) - prompt_tokens_details.cached_tokens (1920) - prompt_tokens_details.audio_tokens (0) = 86')
    expect(row.timestamp).toBe('2026-10-24T00:00:00.000Z')
    expect(row.raw['usage.prompt_tokens_details.cached_tokens']).toBe(1920)
  })

  it('responses cache write example: 12000 input => 1000 uncached, 3000 30m, 4000 12h', () => {
    const row = run(openaiResponsesAdapter, 'B-json', recordsOf('b-openai-responses.json', 'B-json'))[0]!
    expect(row.tokens).toEqual({ uncachedInput: 1000, cacheRead: 4000, cacheWrite: { '5m': 0, '1h': 0, '30m': 3000, '12h': 4000 }, output: 500, reasoning: 0 })
    expect(row.flags).toEqual([])
  })

  it('usage page documented example splits modalities without double counting', () => {
    const row = run(openaiUsageAdapter, 'C-page', recordsOf('c-openai-usage-page.json', 'C-page'))[0]!
    const t = row.tokens
    const excludedInput = (row.excluded.input_audio ?? 0) + (row.excluded.input_image ?? 0)
    expect(t.uncachedInput + t.cacheRead + t.cacheWrite['30m'] + t.cacheWrite['12h'] + excludedInput).toBe(1000)
    expect(t.output + (row.excluded.output_audio ?? 0) + (row.excluded.output_image ?? 0)).toBe(500)
    expect(row.granularity).toBe('time_bucket')
    expect(row.timestamp).toBe('2026-10-24T00:00:00.000Z')
  })
})

describe('Usage API totals versus breakdowns', () => {
  const result = (extra: Record<string, unknown>) => ({
    object: 'bucket',
    start_time: 1792800000,
    end_time: 1792886400,
    results: [{ object: 'organization.usage.completions.result', num_model_requests: 1, output_tokens: 10, model: 'gpt-6.1-sol', ...extra }],
  })

  it('1000 input, 400 cached total with 400 text breakdown, 100 write total with 100 30m breakdown => exactly 500 uncached', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({
      input_tokens: 1000,
      input_cached_tokens: 400,
      input_cached_text_tokens: 400,
      input_cache_write_tokens: 100,
      input_cache_write_30m_tokens: 100,
    }))
    expect(row.tokens.uncachedInput).toBe(500)
    expect(row.tokens.uncachedInput).not.toBe(0)
    expect(row.tokens.cacheRead).toBe(400)
    expect(row.tokens.cacheWrite['30m']).toBe(100)
    expect(row.unresolvedReason).toBeNull()
    expect(row.flags).toEqual([])
  })

  it('same rule with complete zero-valued breakdowns present', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({
      input_tokens: 1000,
      input_cached_tokens: 400,
      input_cached_text_tokens: 400,
      input_cached_audio_tokens: 0,
      input_cached_image_tokens: 0,
      input_cache_write_tokens: 100,
      input_cache_write_30m_tokens: 100,
      input_cache_write_12h_tokens: 0,
      input_uncached_tokens: 500,
      input_text_tokens: 500,
      input_audio_tokens: 0,
      input_image_tokens: 0,
    }))
    expect(row.tokens.uncachedInput).toBe(500)
    expect(row.flags).toEqual([])
  })

  it('totals without breakdown: cache write total goes to 30m with duration_assumed', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({ input_tokens: 900, input_cached_tokens: 100, input_cache_write_tokens: 300 }))
    expect(row.tokens.uncachedInput).toBe(500)
    expect(row.tokens.cacheWrite['30m']).toBe(300)
    expect(row.flags).toContain('duration_assumed')
  })

  it('breakdown only: totals come from the complete breakdowns', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({
      input_tokens: 1000,
      input_cached_text_tokens: 150,
      input_cached_audio_tokens: 30,
      input_cached_image_tokens: 20,
      input_cache_write_30m_tokens: 60,
      input_cache_write_12h_tokens: 40,
    }))
    expect(row.tokens.cacheRead).toBe(150)
    expect(row.tokens.cacheWrite).toEqual({ '5m': 0, '1h': 0, '30m': 60, '12h': 40 })
    expect(row.tokens.uncachedInput).toBe(700)
    expect(row.excluded).toEqual({ input_audio: 30, input_image: 20 })
    expect(row.notMeasured).toEqual(['reasoning'])
  })

  it('missing cache totals and incomplete breakdowns are Not measured, not zero', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({ input_tokens: 1000, input_cached_text_tokens: 100, input_cache_write_30m_tokens: null }))
    expect(row.notMeasured).toEqual(['cacheRead', 'cacheWrite', 'reasoning'])
    expect(row.tokens.uncachedInput).toBe(1000)
  })

  it('cached total and its full breakdown disagree => totals_disagree and Unresolved', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({
      input_tokens: 1000,
      input_cached_tokens: 300,
      input_cached_text_tokens: 200,
      input_cached_audio_tokens: 50,
      input_cached_image_tokens: 0,
    }))
    expect(row.flags).toContain('totals_disagree')
    expect(row.unresolvedReason).toMatch(/differs from input_cached_tokens/)
  })

  it('write total and its full breakdown disagree => totals_disagree', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({
      input_tokens: 1000, input_cache_write_tokens: 100, input_cache_write_30m_tokens: 50, input_cache_write_12h_tokens: 20,
    }))
    expect(row.flags).toContain('totals_disagree')
    expect(row.unresolvedReason).toMatch(/input_cache_write_tokens/)
  })

  it('input_uncached_tokens that differs from the derived value => totals_disagree', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({
      input_tokens: 1000, input_cached_tokens: 400, input_cache_write_tokens: 100, input_uncached_tokens: 450,
    }))
    expect(row.flags).toContain('totals_disagree')
    expect(row.tokens.uncachedInput).toBe(500)
  })

  it('write total with a null 30m part and a stated 12h part: 30m is derived, the 12h tokens stay 12h', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({
      input_tokens: 1000, input_cached_tokens: 0, input_cache_write_tokens: 100, input_cache_write_30m_tokens: null, input_cache_write_12h_tokens: 25,
    }))
    expect(row.tokens.cacheWrite).toEqual({ '5m': 0, '1h': 0, '30m': 75, '12h': 25 })
    expect(row.flags).toEqual([])
    expect(row.unresolvedReason).toBeNull()
    expect(row.tokens.uncachedInput).toBe(900)
    expect(row.mapping.join('\n')).toContain('input_cache_write_tokens (100) - input_cache_write_12h_tokens (25) = 75, derived because input_cache_write_30m_tokens is null')
  })

  it('write total with a stated 30m part and no 12h part: 12h is derived', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({ input_tokens: 1000, input_cached_tokens: 0, input_cache_write_tokens: 100, input_cache_write_30m_tokens: 60 }))
    expect(row.tokens.cacheWrite).toEqual({ '5m': 0, '1h': 0, '30m': 60, '12h': 40 })
    expect(row.flags).toEqual([])
    expect(row.mapping.join('\n')).toContain('derived because input_cache_write_12h_tokens is absent')
  })

  it('write total with no TTL part at all still assumes 30m with duration_assumed', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({ input_tokens: 1000, input_cached_tokens: 0, input_cache_write_tokens: 100, input_cache_write_30m_tokens: null }))
    expect(row.tokens.cacheWrite['30m']).toBe(100)
    expect(row.flags).toEqual(['duration_assumed'])
  })

  it('cached total absent: the cache read total is derived from input, write and uncached totals', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({
      input_tokens: 1000,
      input_cache_write_tokens: 100,
      input_cache_write_30m_tokens: 100,
      input_cache_write_12h_tokens: 0,
      input_uncached_tokens: 500,
    }))
    expect(row.tokens.uncachedInput).toBe(500)
    expect(row.tokens.cacheRead).toBe(400)
    expect(row.notMeasured).toEqual(['reasoning'])
    expect(row.flags).toEqual([])
    expect(row.mapping.join('\n')).toContain('cache read total derived as result.input_tokens (1000) - input_cache_write total (100) - input_uncached_tokens (500) = 400')
  })

  it('cached and write totals absent: an input_uncached_tokens that differs from input_tokens is still flagged', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({ input_tokens: 1000, input_uncached_tokens: 500 }))
    expect(row.flags).toContain('totals_disagree')
    expect(row.unresolvedReason).toMatch(/input_uncached_tokens \(500\) differs/)
    expect(row.notMeasured).toEqual(['cacheRead', 'cacheWrite', 'reasoning'])
  })

  it('cache totals above input => cache_exceeds_input', () => {
    const row = one(openaiUsageAdapter, 'C-page', result({ input_tokens: 100, input_cached_tokens: 90, input_cache_write_tokens: 20 }))
    expect(row.flags).toContain('cache_exceeds_input')
    expect(row.unresolvedReason).not.toBeNull()
    expect(row.tokens.uncachedInput).toBe(0)
  })

  it('tier: batch true wins, default is standard, null is not stated; model null is flagged', () => {
    expect(one(openaiUsageAdapter, 'C-page', result({ input_tokens: 1, batch: true, service_tier: 'default' })).tierStated).toBe('batch')
    expect(one(openaiUsageAdapter, 'C-page', result({ input_tokens: 1, service_tier: 'default' })).tierStated).toBe('standard')
    expect(one(openaiUsageAdapter, 'C-page', result({ input_tokens: 1, service_tier: null })).tierStated).toBeNull()
    const row = one(openaiUsageAdapter, 'C-page', result({ input_tokens: 1, model: null }))
    expect(row.modelLogged).toBeNull()
    expect(row.flags).toContain('model_missing')
  })

  it('a whole page, a bare result and an empty bucket are accepted', () => {
    const page = JSON.parse(readText('c-openai-usage-page.json')) as unknown
    expect(run(openaiUsageAdapter, 'C-page', [{ kind: 'json', value: page, line: null }])).toHaveLength(6)
    expect(one(openaiUsageAdapter, 'C-page', { object: 'organization.usage.completions.result', input_tokens: 5, output_tokens: 1, num_model_requests: 1 }).timestamp).toBeNull()
    expect(run(openaiUsageAdapter, 'C-page', [{ kind: 'json', value: { object: 'bucket', start_time: 1, end_time: 2, results: [] }, line: null }])).toEqual([])
  })

  it('property: text uncached + text cache read + writes + excluded input == input_tokens', () => {
    fc.assert(fc.property(
      fc.record({
        u: fc.tuple(fc.nat(5000), fc.nat(500), fc.nat(500)),
        c: fc.tuple(fc.nat(5000), fc.nat(500), fc.nat(500)),
        w: fc.tuple(fc.nat(2000), fc.nat(2000)),
        withTotals: fc.boolean(),
      }),
      ({ u, c, w, withTotals }) => {
        const cached = c[0] + c[1] + c[2]
        const write = w[0] + w[1]
        const uncached = u[0] + u[1] + u[2]
        const res: Record<string, unknown> = {
          input_tokens: cached + write + uncached,
          input_cached_text_tokens: c[0], input_cached_audio_tokens: c[1], input_cached_image_tokens: c[2],
          input_cache_write_30m_tokens: w[0], input_cache_write_12h_tokens: w[1],
          input_text_tokens: u[0], input_audio_tokens: u[1], input_image_tokens: u[2],
        }
        if (withTotals) Object.assign(res, { input_cached_tokens: cached, input_cache_write_tokens: write, input_uncached_tokens: uncached })
        const row = one(openaiUsageAdapter, 'C-page', result(res))
        const t = row.tokens
        const sum = t.uncachedInput + t.cacheRead + t.cacheWrite['30m'] + t.cacheWrite['12h'] + (row.excluded.input_audio ?? 0) + (row.excluded.input_image ?? 0)
        return row.unresolvedReason === null && sum === cached + write + uncached && t.uncachedInput === u[0] && t.cacheRead === c[0]
      },
    ))
  })
})

describe('reasoning is a breakdown of output, never added', () => {
  it('chat', () => {
    const row = one(openaiChatAdapter, 'A-json', {
      object: 'chat.completion', model: 'o4-mini',
      usage: { prompt_tokens: 10, completion_tokens: 2200, completion_tokens_details: { reasoning_tokens: 1600 } },
    })
    expect(row.tokens.output).toBe(2200)
    expect(row.tokens.reasoning).toBe(1600)
  })

  it('responses reasoning guide example: output 1186 with 1024 reasoning', () => {
    const row = run(openaiResponsesAdapter, 'B-json', recordsOf('b-openai-responses.json', 'B-json'))[1]!
    expect(row.tokens.output).toBe(1186)
    expect(row.tokens.reasoning).toBe(1024)
  })

  it('openrouter', () => {
    const row = run(openrouterAdapter, 'E-json', recordsOf('e-openrouter.json', 'E-json'))[4]!
    expect(row.tokens.output).toBe(15)
    expect(row.tokens.reasoning).toBe(5)
  })

  it('reasoning above output is Unresolved', () => {
    const row = one(openaiResponsesAdapter, 'B-json', {
      object: 'response', model: 'o3', usage: { input_tokens: 5, output_tokens: 10, output_tokens_details: { reasoning_tokens: 20 } },
    })
    expect(row.flags).toContain('totals_disagree')
    expect(row.unresolvedReason).toMatch(/reasoning/)
  })
})

describe('audio, image and video tokens are excluded from token cost', () => {
  it('chat audio row', () => {
    const row = run(openaiChatAdapter, 'A-json', recordsOf('a-openai-chat.json', 'A-json'))[3]!
    expect(row.tokens.uncachedInput).toBe(300)
    expect(row.tokens.output).toBe(80)
    expect(row.excluded).toEqual({ input_audio: 900, output_audio: 420 })
  })

  it('chat image input', () => {
    const row = one(openaiChatAdapter, 'A-json', {
      object: 'chat.completion', model: 'gpt-4o',
      usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100, image_tokens: 765 } },
    })
    expect(row.tokens.uncachedInput).toBe(135)
    expect(row.excluded).toEqual({ input_image: 765 })
  })

  it('openrouter audio and video', () => {
    const row = one(openrouterAdapter, 'E-json', {
      model: 'google/gemini-2.5-flash',
      usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { audio_tokens: 200, video_tokens: 300 }, completion_tokens_details: { image_tokens: 20 } },
    })
    expect(row.tokens.uncachedInput).toBe(500)
    expect(row.tokens.output).toBe(30)
    expect(row.excluded).toEqual({ input_audio: 200, input_video: 300, output_image: 20 })
  })
})

describe('chat and responses details', () => {
  it('chat cache writes go to 30m with duration_assumed', () => {
    const row = run(openaiChatAdapter, 'A-json', recordsOf('a-openai-chat.json', 'A-json'))[2]!
    expect(row.tokens.cacheWrite['30m']).toBe(5000)
    expect(row.flags).toEqual(['duration_assumed'])
    expect(row.mapping.some((m) => m.startsWith('cacheWrite.30m = usage.prompt_tokens_details.cache_write_tokens (5000)'))).toBe(true)
  })

  it('chat write note says the TTL is not reported and 30m is a lower bound, never that only 30m is accepted', () => {
    const row = one(openaiChatAdapter, 'A-json', {
      object: 'chat.completion', model: 'gpt-6.1-sol', usage: { prompt_tokens: 5000, completion_tokens: 10, prompt_tokens_details: { cache_write_tokens: 4000 } },
    })
    const line = row.mapping.find((m) => m.startsWith('cacheWrite.30m'))!
    expect(line).toContain('does not report the cache TTL, so 30m is assumed')
    expect(line).toContain('lower bound if 12h breakpoints were used')
    expect(line).not.toContain('accepts only')
    expect(row.flags).toEqual(['duration_assumed'])
  })

  it('service tiers: default, flex, priority, scale, auto, absent, unknown', () => {
    const tierOf = (service_tier: unknown) => one(openaiChatAdapter, 'A-json', {
      object: 'chat.completion', model: 'gpt-4o', service_tier, usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
    expect(tierOf('default').tierStated).toBe('standard')
    expect(tierOf('flex').tierStated).toBe('flex')
    expect(tierOf('priority').tierStated).toBe('priority')
    expect(tierOf('auto').tierStated).toBeNull()
    expect(tierOf(undefined).tierStated).toBeNull()
    const scale = tierOf('scale')
    expect(scale.tierStated).toBeNull()
    expect(scale.raw.service_tier).toBe('scale')
    expect(scale.unresolvedReason).toBeNull()
    const unknown = tierOf('turbo')
    expect(unknown.tierStated).toBeNull()
    expect(unknown.unresolvedReason).toMatch(/unknown service_tier/)
    const ultra = one(openaiResponsesAdapter, 'B-json', { object: 'response', model: 'gpt-5.6-sol', service_tier: 'ultrafast', usage: { input_tokens: 1, output_tokens: 1 } })
    expect(ultra.tierStated).toBe('ultrafast')
  })

  it('responses: TTL detail present without the write total uses the detail sum', () => {
    const row = one(openaiResponsesAdapter, 'B-json', {
      object: 'response', model: 'gpt-6.1-sol',
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 10, cache_write_tokens_details: { ttl_30m_tokens: 6, ttl_12h_tokens: 4 } }, output_tokens: 1 },
    })
    expect(row.tokens.uncachedInput).toBe(80)
    expect(row.tokens.cacheWrite).toEqual({ '5m': 0, '1h': 0, '30m': 6, '12h': 4 })
    expect(row.notMeasured).toEqual(['reasoning'])
  })

  it('responses: detail sum differs from the write total => totals_disagree', () => {
    const row = run(openaiResponsesAdapter, 'B-jsonl', recordsOf('b-openai-responses.jsonl', 'B-jsonl'))[1]!
    expect(row.flags).toEqual(['totals_disagree'])
    expect(row.unresolvedReason).toContain('(2500)')
  })

  it('absent created timestamp => null', () => {
    const row = run(openrouterAdapter, 'E-json', recordsOf('e-openrouter.json', 'E-json'))[2]!
    expect(row.timestamp).toBeNull()
  })
})

describe('OpenRouter reported charge', () => {
  const base = (usage: Record<string, unknown>) => ({ id: 'gen-1', model: 'openai/gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 2, ...usage } })

  it('BYOK: usage.cost plus upstream_inference_cost, exact decimal sum', () => {
    const row = run(openrouterAdapter, 'E-json', recordsOf('e-openrouter.json', 'E-json'))[0]!
    expect(row.reported).toEqual({ amountUsd: '19.95', field: 'usage.cost + usage.cost_details.upstream_inference_cost', kind: 'charge' })
    const exact = one(openrouterAdapter, 'E-json', base({ cost: 0.1, is_byok: true, cost_details: { upstream_inference_cost: 0.2 } }))
    expect(exact.reported?.amountUsd).toBe('0.3')
  })

  it('documented usage example without is_byok: a positive upstream cost is added, mapping says is_byok was absent', () => {
    const doc = {
      id: 'gen-doc', model: 'anthropic/claude-sonnet-4.5',
      usage: { prompt_tokens: 194, completion_tokens: 2, total_tokens: 196, cost: 0.95, cost_details: { upstream_inference_cost: 19 }, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100 } },
    }
    const row = one(openrouterAdapter, 'E-json', doc)
    expect(row.reported).toEqual({ amountUsd: '19.95', field: 'usage.cost + usage.cost_details.upstream_inference_cost', kind: 'charge' })
    expect(row.unresolvedReason).toBeNull()
    expect(row.mapping.join('\n')).toContain('usage.is_byok absent; upstream_inference_cost is above 0')
    expect(one(openrouterAdapter, 'E-json', base({ cost: 0.95, is_byok: null, cost_details: { upstream_inference_cost: 19 } })).reported?.amountUsd).toBe('19.95')
  })

  it('is_byok absent with upstream 0 or null: usage.cost alone', () => {
    expect(one(openrouterAdapter, 'E-json', base({ cost: 0.0012, cost_details: { upstream_inference_cost: 0 } })).reported).toEqual({ amountUsd: '0.0012', field: 'usage.cost', kind: 'charge' })
    expect(one(openrouterAdapter, 'E-json', base({ cost: 0.0012, cost_details: { upstream_inference_cost: null } })).reported).toEqual({ amountUsd: '0.0012', field: 'usage.cost', kind: 'charge' })
  })

  it('not BYOK: usage.cost alone, even when upstream is present', () => {
    const row = one(openrouterAdapter, 'E-json', base({ cost: 0.0012, is_byok: false, cost_details: { upstream_inference_cost: 0.5 } }))
    expect(row.reported).toEqual({ amountUsd: '0.0012', field: 'usage.cost', kind: 'charge' })
  })

  it('BYOK without upstream cost is Unresolved', () => {
    const row = one(openrouterAdapter, 'E-json', base({ cost: 0.00004, is_byok: true, cost_details: { upstream_inference_cost: null } }))
    expect(row.unresolvedReason).toMatch(/BYOK/)
  })

  it('cost 0 on a :free model is a valid zero charge', () => {
    const row = run(openrouterAdapter, 'E-jsonl', recordsOf('zero-valid-reported-charge.jsonl', 'E-jsonl'))[0]!
    expect(row.reported).toEqual({ amountUsd: '0', field: 'usage.cost', kind: 'charge' })
    expect(row.unresolvedReason).toBeNull()
    expect(row.provider).toBe('meta-llama')
  })

  it('absent or null cost => no reported amount; text cost is Unresolved', () => {
    expect(one(openrouterAdapter, 'E-json', base({})).reported).toBeNull()
    expect(one(openrouterAdapter, 'E-json', base({ cost: null })).reported).toBeNull()
    expect(one(openrouterAdapter, 'E-json', base({ cost: 'abc' })).unresolvedReason).toMatch(/usage.cost is not a number/)
  })

  it('cache write duration and provider by model prefix', () => {
    const w = (model: string) => one(openrouterAdapter, 'E-json', { model, usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 40 } } })
    expect(w('anthropic/claude-sonnet-4.5').tokens.cacheWrite['5m']).toBe(40)
    expect(w('openai/gpt-4o').tokens.cacheWrite['30m']).toBe(40)
    expect(w('qwen/qwen3-max').tokens.cacheWrite['5m']).toBe(40)
    expect(w('openai/gpt-4o').flags).toEqual(['duration_assumed'])
    expect(w('openai/gpt-4o').provider).toBe('openai')
    expect(openrouterProvider('openrouter/auto')).toBe('openrouter')
    expect(openrouterProvider('gpt-4o')).toBe('openrouter')
    expect(openrouterProvider(null)).toBe('openrouter')
  })
})

describe('malformed input never throws', () => {
  const adapters: [Adapter, VariantId][] = [
    [openaiChatAdapter, 'A-jsonl'],
    [openaiResponsesAdapter, 'B-jsonl'],
    [openaiUsageAdapter, 'C-page'],
    [openrouterAdapter, 'E-jsonl'],
  ]
  const bad: RawRecord[] = [
    { kind: 'error', message: 'Unexpected end of JSON input', raw: '{"usage":', line: 3 },
    { kind: 'csv', row: { a: '1' }, line: 2 },
    { kind: 'json', value: 42, line: 1 },
    { kind: 'json', value: null, line: 1 },
    { kind: 'json', value: [1, 2], line: 1 },
    { kind: 'json', value: { id: 'x' }, line: 1 },
    { kind: 'json', value: { usage: { prompt_tokens: 1.5, input_tokens: -1, completion_tokens: 'ten' } }, line: 1 },
    { kind: 'json', value: { results: [{ input_tokens: '12x', output_tokens: 1 }, 'nope', { object: 'organization.usage.embeddings.result', input_tokens: 1 }] }, line: 1 },
  ]
  for (const [adapter, variant] of adapters) {
    it(adapter.id, () => {
      const rows = run(adapter, variant, bad)
      expect(rows.length).toBeGreaterThanOrEqual(bad.length)
      for (const row of rows) {
        expect(row.flags).toContain('malformed')
        expect(row.unresolvedReason).toMatch(/^Malformed: /)
        expect(row.variant).toBe(variant)
        expect(() => NormalizedUsageRow.parse({ ...row, rowIndex: 0 })).not.toThrow()
      }
    })
  }

  it('reader errors keep their message', () => {
    const rows = run(openaiChatAdapter, 'A-jsonl', recordsOf('a-openai-chat.jsonl', 'A-jsonl'))
    expect(rows[2]!.unresolvedReason).toBe('Malformed: invalid JSON')
    expect(rows[2]!.raw.record).toContain('chatcmpl-a2-0003')
  })

  it('invalid token value names the field', () => {
    const rows = run(openrouterAdapter, 'E-jsonl', recordsOf('e-openrouter.jsonl', 'E-jsonl'))
    expect(rows[5]!.unresolvedReason).toBe('Malformed: usage.completion_tokens not a non-negative integer')
  })
})

describe('score() on samples', () => {
  const json = (value: unknown): RawRecord => ({ kind: 'json', value, line: 1 })
  const first = (file: string, variant: VariantId) => recordsOf(file, variant)[0]!
  const all = [openaiChatAdapter, openaiResponsesAdapter, openaiUsageAdapter, openrouterAdapter]
  const best = (rec: RawRecord) => all.map((a) => ({ id: a.source, s: a.score(rec).score })).sort((x, y) => y.s - x.s)[0]!.id

  it('each fixture sample is won by its own source', () => {
    expect(best(first('a-openai-chat.json', 'A-json'))).toBe('A')
    expect(best(first('a-openai-chat.jsonl', 'A-jsonl'))).toBe('A')
    expect(best(first('edge-mixed-models.jsonl', 'A-jsonl'))).toBe('A')
    expect(best(first('b-openai-responses.json', 'B-json'))).toBe('B')
    expect(best(first('c-openai-usage-page.json', 'C-page'))).toBe('C')
    expect(best(first('e-openrouter.json', 'E-json'))).toBe('E')
    expect(best(first('e-openrouter.jsonl', 'E-jsonl'))).toBe('E')
    expect(best(first('zero-valid-reported-charge.jsonl', 'E-jsonl'))).toBe('E')
  })

  it('scores stay in 0..1 with a reason', () => {
    for (const a of all) {
      for (const rec of [first('a-openai-chat.json', 'A-json'), json(null), json('x'), { kind: 'csv', row: { model: 'x' }, line: 1 } as RawRecord]) {
        const s = a.score(rec)
        expect(s.score).toBeGreaterThanOrEqual(0)
        expect(s.score).toBeLessThanOrEqual(1)
        expect(s.reason.length).toBeGreaterThan(0)
      }
    }
  })

  it('a whole usage page object scores high for C', () => {
    expect(openaiUsageAdapter.score(json(JSON.parse(readText('c-openai-usage-page.json')))).score).toBeGreaterThan(0.9)
  })

  it('an Anthropic message does not look like a Responses object', () => {
    const msg = json({ type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 } })
    expect(openaiResponsesAdapter.score(msg).score).toBeLessThan(0.2)
    expect(openaiChatAdapter.score(msg).score).toBe(0)
  })

  it('embeddings responses and embeddings usage pages score 0, so they are not taken for chat or completions usage', () => {
    const embedding = json({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }], model: 'text-embedding-3-small', usage: { prompt_tokens: 8000, total_tokens: 8000 } })
    for (const a of all) expect(a.score(embedding).score, a.id).toBe(0)
    expect(openaiChatAdapter.score(embedding).reason).toBe('object "list" is not a chat completion')
    const noObject = json({ model: 'text-embedding-3-small', usage: { prompt_tokens: 8000, total_tokens: 8000 } })
    expect(openaiChatAdapter.score(noObject).score).toBe(0)
    expect(openrouterAdapter.score(noObject).score).toBe(0)
    const page = json({
      object: 'page',
      data: [{ object: 'bucket', start_time: 1792800000, end_time: 1792886400, results: [{ object: 'organization.usage.embeddings.result', input_tokens: 16000, num_model_requests: 2, model: 'text-embedding-3-small' }] }],
    })
    expect(openaiUsageAdapter.score(page).score).toBe(0)
    // A chat completion keeps its scores.
    const chat = json({ object: 'chat.completion', model: 'gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 2 } })
    expect(openaiChatAdapter.score(chat).score).toBe(0.95)
    expect(openaiChatAdapter.score(json({ model: 'gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 2 } })).score).toBe(0.7)
  })

  it('CSV rows and non-usage JSON score 0', () => {
    for (const a of all) {
      expect(a.score({ kind: 'csv', row: { request_id: '', spend: '' }, line: 1 }).score).toBe(0)
      expect(a.score(json({ hello: 'world' })).score).toBe(0)
    }
  })
})

describe('copy rules', () => {
  it('adapter sources have no em dashes', () => {
    for (const f of ['openaiChat.ts', 'openaiResponses.ts', 'openaiUsage.ts', 'openrouter.ts']) {
      const text = readFileSync(new URL(`../../src/engine/adapters/${f}`, import.meta.url), 'utf8')
      expect(text.includes('—'), f).toBe(false)
    }
  })
})
