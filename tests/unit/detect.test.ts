import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DetectionResult, VariantId } from '../../src/engine/contracts'
import { VARIANTS, adapterForVariant } from '../../src/engine/adapters'
import { detectFromSample, formatForVariant, parseJsonPrefix, sampleRecordsFromText } from '../../src/engine/detect'
import { VARIANT_FORMAT } from '../../src/engine/stream'

const FIXTURES = join(process.cwd(), 'fixtures')

/** Every fixture and the variant it must be detected as. Fixtures owned by others are checked when present. */
const EXPECTED: Record<string, VariantId> = {
  'a-openai-chat.json': 'A-json',
  'a-openai-chat.jsonl': 'A-jsonl',
  'b-openai-responses.json': 'B-json',
  'b-openai-responses.jsonl': 'B-jsonl',
  'c-openai-usage-page.json': 'C-page',
  'd-anthropic-messages.json': 'D-json',
  'd-anthropic-messages.jsonl': 'D-jsonl',
  'e-openrouter.json': 'E-json',
  'e-openrouter.jsonl': 'E-jsonl',
  'f-litellm-spend.csv': 'F-csv',
  'f-litellm-spend.json': 'F-json',
  'g-otel-spans.json': 'G-otlp',
  'g-otel-spans.jsonl': 'G-otlp-jsonl',
  'h-custom.csv': 'H-csv',
  'edge-bom.csv': 'F-csv',
  'edge-quoted-newlines.csv': 'F-csv',
  'edge-missing-columns.csv': 'H-csv',
  'edge-mixed-models.jsonl': 'A-jsonl',
  'edge-malformed.jsonl': 'D-jsonl',
  'edge-multibyte-boundary.csv': 'F-csv',
  'zero-valid-explicit-rate.json': 'F-json',
  'zero-valid-reported-charge.jsonl': 'E-jsonl',
  'zero-not-priced.jsonl': 'A-jsonl',
  'zero-unresolved.json': 'F-json',
}

/** The first 64 KiB, decoded the way the worker reads a sample. */
function sample(file: string): string {
  return readFileSync(join(FIXTURES, file)).subarray(0, 65536).toString('utf8')
}

describe('detectFromSample on fixtures', () => {
  for (const [file, variant] of Object.entries(EXPECTED)) {
    it.skipIf(!existsSync(join(FIXTURES, file)))(`${file} is ${variant}`, () => {
      const result = detectFromSample(sample(file), file)
      expect(() => DetectionResult.parse(result)).not.toThrow()
      expect(result.variant, result.reason).toBe(variant)
      expect(result.confidence).toBeGreaterThanOrEqual(variant === 'H-csv' ? 0.5 : 0.6)
      expect(result.candidates[0]?.variant).toBe(variant)
      if (variant.endsWith('csv')) expect(result.csvHeaders?.length).toBeGreaterThan(1)
      else expect(result.csvHeaders).toBeNull()
    })
  }

  it('says a non-LiteLLM CSV needs a mapping and returns its headers', () => {
    const result = detectFromSample(sample('h-custom.csv'), 'h-custom.csv')
    expect(result.reason).toContain('needs a column mapping')
    expect(result.csvHeaders).toEqual(['event_time', 'vendor', 'model_name', 'input_tok', 'cached_tok', 'cache_write_tok', 'output_tok', 'reasoning_tok', 'service_level', 'billed_usd', 'note'])
  })

  it('the variant list names a fixture for every variant', () => {
    expect(VARIANTS.map((v) => v.id).sort()).toEqual([...VariantId.options].sort())
    for (const v of VARIANTS) {
      expect(EXPECTED[v.fixture]).toBe(v.id)
      expect(adapterForVariant(v.id).variants).toContain(v.id)
      expect(v.label).not.toMatch(/[–—]/)
    }
  })
})

/** OpenAI embeddings responses and usage pages: not a supported variant, so never priced as chat or completions usage. */
function embeddingCases(): [string, string, string][] {
  const response = (i: number) => ({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.01 * i, 0.02] }], model: 'text-embedding-3-small', usage: { prompt_tokens: 8000 + i, total_tokens: 8000 + i } })
  const lines = [1, 2, 3].map((i) => JSON.stringify(response(i))).join('\n') + '\n'
  const bare = [1, 2].map((i) => JSON.stringify({ model: 'text-embedding-3-small', usage: { prompt_tokens: 10 * i, total_tokens: 10 * i } })).join('\n') + '\n'
  const page = {
    object: 'page',
    data: [{ object: 'bucket', start_time: 1792800000, end_time: 1792886400, results: [{ object: 'organization.usage.embeddings.result', input_tokens: 16000, num_model_requests: 2, model: 'text-embedding-3-small' }] }],
    has_more: false,
  }
  return [
    ['embeddings responses as JSONL', lines, 'embeddings.jsonl'],
    ['one embeddings response on one line', JSON.stringify(response(1)), 'embedding.json'],
    ['one pretty-printed embeddings response', JSON.stringify(response(1), null, 2), 'embedding.json'],
    ['a JSON array of embeddings responses', JSON.stringify([response(1), response(2)]), 'embeddings.json'],
    ['prompt-only usage lines without completion_tokens', bare, 'usage.jsonl'],
    ['an embeddings Usage API page', JSON.stringify(page, null, 2), 'usage-embeddings.json'],
  ]
}

describe('unsupported input', () => {
  const cases: [string, string, string][] = [
    ['empty file', '', 'empty.json'],
    ['whitespace', '   \n\n', 'blank.txt'],
    ['plain text', 'just some words\nand some more words\n', 'notes.txt'],
    ['single JSON object', '{\n  "hello": "world",\n  "items": [1, 2, 3]\n}\n', 'thing.json'],
    ['JSON array of unrelated objects', '[{"name":"a","size":1},{"name":"b","size":2}]', 'list.json'],
    ['JSONL of unrelated objects', '{"event":"click","x":1}\n{"event":"scroll","y":2}\n', 'events.jsonl'],
    ['one column CSV', 'value\n1\n2\n', 'one.csv'],
    ['broken JSON', '[{"a": 1,, }]', 'broken.json'],
    ['a JSON number', '42', 'n.json'],
    ...embeddingCases(),
  ]
  for (const [name, text, file] of cases) {
    it(`${name} is not supported yet`, () => {
      const result = detectFromSample(text, file)
      expect(result.variant).toBeNull()
      expect(result.confidence).toBe(0)
      expect(result.reason).toContain('not supported yet')
      expect(() => DetectionResult.parse(result)).not.toThrow()
    })
  }
})

describe('cut samples and containers', () => {
  const message = (i: number) => ({
    id: `msg_${i}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: 'x'.repeat(400) }],
    usage: { input_tokens: 100 + i, output_tokens: 10 },
  })

  it('detects a JSON array that is cut at 64 KiB and keeps only whole elements', () => {
    const full = JSON.stringify(Array.from({ length: 400 }, (_, i) => message(i)))
    expect(full.length).toBeGreaterThan(65536)
    const cut = full.slice(0, 65536)
    expect(detectFromSample(cut, 'big.json').variant).toBe('D-json')
    const records = sampleRecordsFromText(cut, 'D-json', 10_000)
    expect(records.length).toBeGreaterThan(50)
    expect(records.every((r) => r.kind === 'json')).toBe(true)
    const last = records.at(-1)
    expect(last?.kind === 'json' && (last.value as { usage: { output_tokens: number } }).usage.output_tokens).toBe(10)
  })

  it('drops a cut final JSONL line and a cut final CSV row', () => {
    const lines = Array.from({ length: 300 }, (_, i) => JSON.stringify(message(i))).join('\n')
    const cut = lines.slice(0, 65536)
    const records = sampleRecordsFromText(cut, 'D-jsonl', 10_000)
    expect(records.every((r) => r.kind === 'json')).toBe(true)
    expect(detectFromSample(cut, 'big.jsonl').variant).toBe('D-jsonl')

    const csv = 'a,b,c\n1,2,3\n4,5,6\n7,8'
    expect(sampleRecordsFromText(csv, 'H-csv', 10, { truncated: true })).toHaveLength(2)
    expect(sampleRecordsFromText(csv, 'H-csv', 10, { truncated: false })).toHaveLength(3)
  })

  it('reads a single-line OTLP export as G-otlp and many lines as G-otlp-jsonl', () => {
    const req = readFileSync(join(FIXTURES, 'g-otel-spans.json'), 'utf8')
    const one = JSON.stringify(JSON.parse(req))
    expect(detectFromSample(one, 'trace.json').variant).toBe('G-otlp')
    expect(detectFromSample(`${one}\n${one}\n`, 'trace.jsonl').variant).toBe('G-otlp-jsonl')
    expect(sampleRecordsFromText(req, 'G-otlp', 10)).toHaveLength(2)
  })

  it('treats a single Messages object on one line as JSONL', () => {
    expect(detectFromSample(JSON.stringify(message(1)), 'one.jsonl').variant).toBe('D-jsonl')
  })

  it('numbers CSV lines the way the stream reader does, quoted newlines included', () => {
    const records = sampleRecordsFromText('a,b\n"x\ny",1\n\nz,2\nw\n', 'H-csv', 10, { truncated: false })
    expect(records.map((r) => r.line)).toEqual([2, 4, 5])
    expect(records[2]?.kind).toBe('error')
    expect(records[2]?.kind === 'error' && records[2].message).toMatch(/^Line 5: TooFewFields/)
  })

  it('parses JSON prefixes without inventing values', () => {
    const p = parseJsonPrefix('{"a": [1, 2, {"b": "c"}, {"d": 12')
    expect(p.cut).toBe(true)
    expect(p.value).toEqual({ a: [1, 2, { b: 'c' }, {}] })
    expect(parseJsonPrefix('[1, 2]').value).toEqual([1, 2])
    expect(parseJsonPrefix('{"s": "a\\"b"} tail').end).toBe(13)
    expect(() => parseJsonPrefix('{"a" 1}')).toThrow()
  })

  it('maps every variant to the stream format the reader uses', () => {
    for (const v of VariantId.options) expect(formatForVariant(v)).toBe(VARIANT_FORMAT[v])
  })
})
