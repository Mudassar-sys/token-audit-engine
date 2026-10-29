import { describe, expect, it } from 'vitest'
import type { RawRecord } from '../../src/engine/adapters/types'
import { sampleRecordsFromBlob, streamRecords, type StreamControl, type StreamFormat } from '../../src/engine/stream/index'

const enc = new TextEncoder()

/** A Blob-like object whose stream() yields fixed-size byte chunks, to force chunk boundaries. */
function chunkedBlob(data: string | Uint8Array, chunk: number): Blob {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  return {
    size: bytes.byteLength,
    stream() {
      let off = 0
      return new ReadableStream<Uint8Array>({
        pull(c) {
          if (off >= bytes.byteLength) {
            c.close()
            return
          }
          c.enqueue(bytes.slice(off, off + chunk))
          off += chunk
        },
      })
    },
  } as unknown as Blob
}

function control(over: Partial<StreamControl> = {}): StreamControl {
  return { signal: new AbortController().signal, onBytes() {}, onChunk() {}, ...over }
}

async function collect(file: Blob, format: StreamFormat, over: Partial<StreamControl> = {}) {
  const records: RawRecord[] = []
  const batches: number[] = []
  await streamRecords(file, format, control(over), (recs) => {
    batches.push(recs.length)
    records.push(...recs)
  })
  return { records, batches }
}

const json = (r: RawRecord | undefined) => (r && r.kind === 'json' ? r.value : undefined)

describe('jsonl', () => {
  it('handles a BOM, CRLF, blank lines, a malformed line and a last line without newline', async () => {
    const text = '\uFEFF{"a":1}\r\n{"b":2}\r\n\r\nnot json\r\n{"c":"caf\u00e9"}'
    const { records } = await collect(new Blob([text]), 'jsonl')
    expect(records).toHaveLength(4)
    expect(records[0]).toEqual({ kind: 'json', value: { a: 1 }, line: 1 })
    expect(records[1]).toEqual({ kind: 'json', value: { b: 2 }, line: 2 })
    expect(records[2]?.kind).toBe('error')
    expect(records[2]?.line).toBe(4)
    expect(records[3]).toEqual({ kind: 'json', value: { c: 'caf\u00e9' }, line: 5 })
  })

  it('decodes multibyte characters split over byte chunks', async () => {
    const text = '{"t":"\u65e5\u672c\u8a9e \ud83d\ude00"}\n{"t":"\u00fc"}\n'
    for (const size of [1, 2, 3, 5]) {
      const { records } = await collect(chunkedBlob(text, size), 'jsonl')
      expect(records.map(json)).toEqual([{ t: '\u65e5\u672c\u8a9e \ud83d\ude00' }, { t: '\u00fc' }])
    }
  })

  it('batches at most 1,000 records per call and reports bytes and every chunk', async () => {
    const lines = Array.from({ length: 2500 }, (_, i) => JSON.stringify({ i })).join('\n')
    const bytes = enc.encode(lines)
    let lastBytes = 0
    let chunkTotal = 0
    const { records, batches } = await collect(chunkedBlob(bytes, 997), 'jsonl', {
      onBytes: (n) => {
        expect(n).toBeGreaterThanOrEqual(lastBytes)
        lastBytes = n
      },
      onChunk: (b) => {
        chunkTotal += b.byteLength
      },
    })
    expect(records).toHaveLength(2500)
    expect(Math.max(...batches)).toBeLessThanOrEqual(1000)
    expect(lastBytes).toBe(bytes.byteLength)
    expect(chunkTotal).toBe(bytes.byteLength)
  })

  it('otlp-jsonl yields one export request per line', async () => {
    const req = { resourceSpans: [{ scopeSpans: [] }] }
    const { records } = await collect(new Blob([`${JSON.stringify(req)}\n${JSON.stringify(req)}\n`]), 'otlp-jsonl')
    expect(records.map(json)).toEqual([req, req])
  })
})

describe('json documents', () => {
  it('streams each element of a top-level array across tiny chunks', async () => {
    const arr = [{ id: 'x', usage: { prompt_tokens: 5 } }, { id: '\u00e9', n: 1.5 }, [1, 2]]
    const { records } = await collect(chunkedBlob(`\uFEFF ${JSON.stringify(arr)}\n`, 3), 'json-array')
    expect(records.map(json)).toEqual(arr)
    expect(records.every((r) => r.kind === 'json' && r.line === null)).toBe(true)
  })

  it('yields an error record after the parsed elements of a truncated array', async () => {
    const { records } = await collect(new Blob(['[{"a":1},{"b":2},{"c":']), 'json-array')
    expect(records.slice(0, 2).map(json)).toEqual([{ a: 1 }, { b: 2 }])
    expect(records[2]?.kind).toBe('error')
  })

  it('rejects a non-array document for json-array', async () => {
    const { records } = await collect(new Blob(['{"a":1}']), 'json-array')
    expect(records).toHaveLength(1)
    expect(records[0]?.kind).toBe('error')
  })

  it('usage page yields each bucket of data', async () => {
    const page = {
      object: 'page',
      data: [
        { object: 'bucket', start_time: 1, results: [{ input_tokens: 1000 }] },
        { object: 'bucket', start_time: 2, results: [] },
      ],
      has_more: false,
      next_page: null,
    }
    const { records } = await collect(chunkedBlob(JSON.stringify(page), 7), 'usage-page')
    expect(records.map(json)).toEqual(page.data)
  })

  it('otlp yields each resourceSpans element', async () => {
    const req = {
      resourceSpans: [
        { resource: { attributes: [] }, scopeSpans: [{ spans: [{ name: 'chat' }] }] },
        { resource: { attributes: [] }, scopeSpans: [] },
      ],
    }
    const { records } = await collect(new Blob([JSON.stringify(req)]), 'otlp')
    expect(records.map(json)).toEqual(req.resourceSpans)
  })
})

describe('csv', () => {
  const csvText =
    '\uFEFFrequest_id,model,messages,spend\r\n' +
    'r1,gpt-4o,"line one\r\nline two, with comma",0.5\r\n' +
    'r2,claude-haiku-4-5,"caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00 ""quoted""",0\r\n' +
    '\r\n' +
    'r3,gpt-4o-mini,short\r\n' +
    'r4,gpt-4o,\u00fc\u00f6\u00e4,1\r\n'

  it('parses BOM, quoted newlines and multibyte text across tiny chunks', async () => {
    for (const size of [1, 2, 3, 7, 64, 4096]) {
      const { records } = await collect(chunkedBlob(csvText, size), 'csv', { csvChunkSize: size })
      const ok = records.filter((r) => r.kind === 'csv')
      expect(ok.map((r) => r.kind === 'csv' && r.row)).toEqual([
        { request_id: 'r1', model: 'gpt-4o', messages: 'line one\r\nline two, with comma', spend: '0.5' },
        { request_id: 'r2', model: 'claude-haiku-4-5', messages: 'caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude00 "quoted"', spend: '0' },
        { request_id: 'r4', model: 'gpt-4o', messages: '\u00fc\u00f6\u00e4', spend: '1' },
      ])
      expect(ok.map((r) => r.line)).toEqual([2, 4, 7])
      const bad = records.filter((r) => r.kind === 'error')
      expect(bad).toHaveLength(1)
      expect(bad[0]?.line).toBe(6)
      expect(bad[0]?.kind === 'error' && bad[0].message).toMatch(/TooFewFields/)
    }
  })

  it('detects a semicolon delimiter and LF endings', async () => {
    const { records } = await collect(new Blob(['a;b\n1;2\n3;4']), 'csv')
    expect(records.map((r) => r.kind === 'csv' && r.row)).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ])
  })

  it('handles a header-only file and an empty file', async () => {
    expect((await collect(new Blob(['a,b\n']), 'csv')).records).toEqual([])
    expect((await collect(new Blob(['']), 'csv')).records).toEqual([])
  })
})

/** Wait a little on a real timer. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('backpressure', () => {
  it('jsonl: a slow onRecords pauses reading', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(20) }))
    const text = lines.join('\n') + '\n'
    const CHUNK = 4096
    let bytesRead = 0
    let consumed = 0
    let calls = 0
    await streamRecords(
      chunkedBlob(text, CHUNK),
      'jsonl',
      control({ onBytes: (n) => (bytesRead = n) }),
      async (recs) => {
        calls++
        for (const r of recs) consumed += enc.encode(lines[(r.line ?? 1) - 1] ?? '').byteLength + 1
        // Reading may only run ahead of what was handed over by the current chunk.
        expect(bytesRead - consumed).toBeLessThanOrEqual(CHUNK)
        const before = bytesRead
        await delay(2)
        expect(bytesRead).toBe(before)
      },
    )
    expect(calls).toBeGreaterThan(5)
    expect(consumed).toBe(enc.encode(text).byteLength)
  })

  it('csv: a slow onRecords pauses reading', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => `r${i},gpt-4o,"m\n${i}",0.1`)
    const text = `request_id,model,messages,spend\n${rows.join('\n')}\n`
    const CHUNK = 1024
    let bytesRead = 0
    let maxAhead = 0
    let delivered = 0
    await streamRecords(
      chunkedBlob(text, 8192),
      'csv',
      control({ onBytes: (n) => (bytesRead = n), csvChunkSize: CHUNK }),
      async (recs) => {
        delivered += recs.length
        const deliveredBytes = text.split('\n').slice(0, 1 + delivered * 2).join('\n').length
        maxAhead = Math.max(maxAhead, bytesRead - deliveredBytes)
        const before = bytesRead
        await delay(1)
        expect(bytesRead).toBe(before)
      },
    )
    expect(delivered).toBe(2000)
    expect(maxAhead).toBeLessThanOrEqual(2 * CHUNK)
  })
})

describe('abort', () => {
  const big = Array.from({ length: 20000 }, (_, i) => JSON.stringify({ i, pad: 'y'.repeat(40) })).join('\n')

  it('stops promptly and throws an AbortError', async () => {
    const ac = new AbortController()
    let bytesRead = 0
    let calls = 0
    const p = streamRecords(chunkedBlob(big, 4096), 'jsonl', control({ signal: ac.signal, onBytes: (n) => (bytesRead = n) }), () => {
      calls++
      if (calls === 2) ac.abort()
    })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(2)
    expect(bytesRead).toBeLessThan(3 * 4096)
  })

  it('rejects promptly even while onRecords never settles', async () => {
    for (const format of ['jsonl', 'csv'] as const) {
      const ac = new AbortController()
      const text = format === 'csv' ? `i,pad\n${Array.from({ length: 5000 }, (_, i) => `${i},z`).join('\n')}` : big
      const p = streamRecords(chunkedBlob(text, 4096), format, control({ signal: ac.signal, csvChunkSize: 4096 }), () => new Promise<void>(() => {}))
      setTimeout(() => ac.abort(), 5)
      const t0 = Date.now()
      await expect(p).rejects.toMatchObject({ name: 'AbortError' })
      expect(Date.now() - t0).toBeLessThan(1000)
    }
  })

  it('a signal that is already aborted rejects without reading', async () => {
    const ac = new AbortController()
    ac.abort()
    let bytes = 0
    await expect(streamRecords(new Blob([big]), 'json-array', control({ signal: ac.signal, onBytes: (n) => (bytes = n) }), () => {})).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(bytes).toBe(0)
  })
})

describe('sampleRecordsFromBlob', () => {
  it('returns at most max records and stops reading early', async () => {
    const text = Array.from({ length: 10000 }, (_, i) => JSON.stringify({ i })).join('\n')
    const recs = await sampleRecordsFromBlob(new Blob([text]), 'jsonl', 50)
    expect(recs).toHaveLength(50)
    expect(json(recs[49])).toEqual({ i: 49 })
  })

  it('returns everything for a short file, including CSV', async () => {
    const recs = await sampleRecordsFromBlob(new Blob(['a,b\n1,2\n3,4\n']), 'csv', 5000)
    expect(recs.map((r) => r.kind === 'csv' && r.row)).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ])
  })

  it('passes through an outer abort', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(sampleRecordsFromBlob(new Blob(['{"a":1}']), 'jsonl', 5, ac.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
