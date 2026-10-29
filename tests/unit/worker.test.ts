import 'fake-indexeddb/auto'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DURATION_MAP, type CustomCsvMapping, type DetectionResult, type ScenarioRequest, type WorkerRequest, type WorkerResponse } from '../../src/engine/contracts'
import { CSV_HEADER } from '../../src/engine/export'
import { generateSampleChunks } from '../../src/engine/sample'
import { createScenario } from '../../src/engine/savings'
import { EXPORT_PART_BYTES, utf8Length } from '../../src/worker/csvExport'
import type { RequestEnvelope, ResponseEnvelope } from '../../src/worker/engine.worker'
import * as store from '../../src/worker/store'
import { TEST_META, TEST_SNAPSHOT } from './helpers/testSnapshot'

// Every store call goes to the real IndexedDB store unless a test overrides it once.
vi.mock('../../src/worker/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/worker/store')>()
  return {
    ...real,
    putRows: vi.fn(real.putRows),
    putAudit: vi.fn(real.putAudit),
    deleteAudit: vi.fn(real.deleteAudit),
    iterateRows: vi.fn(real.iterateRows),
  }
})

const MAPPING = JSON.parse(readFileSync(new URL('../../fixtures/h-custom-mapping.json', import.meta.url), 'utf8')) as CustomCsvMapping
const HEADER = 'event_time,vendor,model_name,input_tok,cached_tok,cache_write_tok,output_tok,reasoning_tok,service_level,billed_usd,note'
const DETECTION: DetectionResult = { variant: 'H-csv', confidence: 1, reason: 'test', candidates: [], csvHeaders: HEADER.split(',') }

/** A custom CSV with `n` rows; `noteBytes` pads each row with a long free-text column. */
function csvFile(n: number, noteBytes = 10): File {
  const note = 'x'.repeat(noteBytes)
  const lines = [HEADER]
  for (let i = 0; i < n; i++) lines.push(`2026-10-10T08:15:00Z,openai,gpt-4o,1000,400,0,200,50,Standard,,${note}`)
  return new File([lines.join('\n') + '\n'], 'usage.csv', { type: 'text/csv' })
}

function importRequest(file: File): WorkerRequest {
  return {
    type: 'import',
    file,
    fileName: file.name,
    variant: 'H-csv',
    detection: DETECTION,
    overridden: false,
    mapping: MAPPING,
    snapshot: TEST_SNAPSHOT,
    snapshotMeta: TEST_META,
  }
}

// A stand-in for the worker global scope: captures the message listener and every reply.
const replies: ResponseEnvelope[] = []
let listener: ((event: { data: RequestEnvelope }) => void) | null = null
let estimate: () => Promise<{ usage?: number; quota?: number }> = async () => ({ usage: 0, quota: 1e12 })
const fakeScope = {
  postMessage: (env: ResponseEnvelope) => replies.push(env),
  addEventListener: (_type: string, fn: (event: { data: RequestEnvelope }) => void) => {
    listener = fn
  },
  navigator: { storage: { estimate: () => estimate() } },
}

let nextId = 1
function send(request: WorkerRequest): number {
  const id = nextId++
  listener?.({ data: { id, request } })
  return id
}

const PROGRESS_TYPES = new Set<WorkerResponse['type']>(['progress', 'sampleProgress', 'exportProgress', 'scenarioProgress'])

/** The first reply to request `id` that is not a progress message. */
async function reply(id: number): Promise<WorkerResponse> {
  return vi.waitFor(
    () => {
      const env = replies.find((r) => r.id === id && !PROGRESS_TYPES.has(r.response.type))
      if (!env) throw new Error(`no reply to request ${id} yet`)
      return env.response
    },
    { timeout: 20000, interval: 2 },
  )
}

async function importFile(file: File): Promise<Extract<WorkerResponse, { type: 'done' }>> {
  const res = await reply(send(importRequest(file)))
  if (res.type !== 'done') throw new Error(`import failed: ${JSON.stringify(res)}`)
  return res
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

// The worker module reads the global scope when it loads, so it is imported after the stand-in is in place.
let worker: typeof import('../../src/worker/engine.worker')

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = fakeScope
  worker = await import('../../src/worker/engine.worker')
  expect(listener).not.toBeNull()
})

afterEach(async () => {
  estimate = async () => ({ usage: 0, quota: 1e12 })
  expect((await reply(send({ type: 'clear' }))).type).toBe('cleared')
  replies.length = 0
})

describe('engine worker: mapping preview', () => {
  it('maps 20 rows even when rows are long and 20 of them do not fit in 64 KiB', async () => {
    const file = csvFile(30, 5000)
    expect(file.size).toBeGreaterThan(20 * 5000)
    const res = await reply(send({ type: 'preview', file, mapping: MAPPING }))
    expect(res.type).toBe('preview')
    if (res.type !== 'preview') return
    expect(res.rows).toHaveLength(20)
    expect(res.rows.map((r) => r.rowIndex)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(res.errors).toEqual([])
  })

  it('maps every row of a file shorter than 20 rows', async () => {
    const res = await reply(send({ type: 'preview', file: csvFile(7), mapping: MAPPING }))
    expect(res.type === 'preview' && res.rows.length).toBe(7)
  })
})

describe('engine worker: CSV export', () => {
  it('exports every stored row', async () => {
    const done = await importFile(csvFile(12000))
    const res = await reply(send({ type: 'exportCsv', target: null }))
    expect(res.type).toBe('csv')
    if (res.type !== 'csv') return
    expect(res.rows).toBe(12000)
    expect(res.rows).toBe(done.summary.coverage.totalRows)
    const text = await (res.blob as Blob).text()
    expect(text.trimEnd().split('\n')).toHaveLength(12001)
  })

  it('stops with a clear error, never a short file, when an import starts during the export', async () => {
    await importFile(csvFile(12000))
    let next: number | null = null
    vi.mocked(store.iterateRows).mockImplementationOnce(async (auditId, size, cb) => {
      const real = (await vi.importActual<typeof import('../../src/worker/store')>('../../src/worker/store')).iterateRows
      return real(auditId, size, async (rows) => {
        if (next === null) {
          // The visitor starts a new import after the first batch was read.
          next = send(importRequest(csvFile(5)))
          await new Promise((r) => setTimeout(r, 20))
        }
        await cb(rows)
      })
    })
    const res = await reply(send({ type: 'exportCsv', target: null }))
    expect(res).toEqual({ type: 'error', code: 'internal', message: 'The CSV export stopped because a new import started. No complete file was saved. A file you chose may be empty or partial, so export again.' })
    expect(next).not.toBeNull()
    expect((await reply(next!)).type).toBe('done')
  })

  it('stops with a clear error when local data is cleared during the export', async () => {
    await importFile(csvFile(12000))
    let cleared: number | null = null
    vi.mocked(store.iterateRows).mockImplementationOnce(async (auditId, size, cb) => {
      const real = (await vi.importActual<typeof import('../../src/worker/store')>('../../src/worker/store')).iterateRows
      return real(auditId, size, async (rows) => {
        if (cleared === null) {
          cleared = send({ type: 'clear' })
          await new Promise((r) => setTimeout(r, 20))
        }
        await cb(rows)
      })
    })
    const res = await reply(send({ type: 'exportCsv', target: null }))
    expect(res).toEqual({ type: 'error', code: 'internal', message: 'The CSV export stopped because local data was cleared. No complete file was saved. A file you chose may be empty or partial, so export again.' })
    expect((await reply(cleared!)).type).toBe('cleared')
  })

  it('refuses to save when fewer rows are read than the import stored', async () => {
    const done = await importFile(csvFile(12000))
    vi.mocked(store.iterateRows).mockImplementationOnce(async (auditId, size, cb) => {
      const real = await vi.importActual<typeof import('../../src/worker/store')>('../../src/worker/store')
      let first = true
      return real.iterateRows(auditId, size, async (rows) => {
        // Rows disappear behind the worker's back after the first batch.
        if (first) await real.deleteAudit(auditId)
        first = false
        await cb(rows)
      })
    })
    const res = await reply(send({ type: 'exportCsv', target: null }))
    expect(res.type).toBe('error')
    const message = res.type === 'error' ? res.message : ''
    const read = Number(/read (\d+) of/.exec(message)?.[1])
    expect(read).toBeLessThan(done.summary.coverage.totalRows)
    expect(message).toBe(`The CSV export read ${read} of ${done.summary.coverage.totalRows} rows, so no complete file was saved. A file you chose may be empty or partial, so export again.`)
  })
})

describe('engine worker: cancel replies', () => {
  it('answers a cancel sent while the storage estimate runs, even when the quota check would fail', async () => {
    const gate = deferred<{ usage: number; quota: number }>()
    estimate = () => gate.promise
    const importId = send(importRequest(csvFile(10)))
    const cancelId = send({ type: 'cancel' })
    gate.resolve({ usage: 0, quota: 1 })
    const [a, b] = await Promise.all([reply(importId), reply(cancelId)])
    expect(a.type).toBe('cancelled')
    expect(b).toEqual(a)
  })

  it('answers a repeated cancel', async () => {
    const importId = send(importRequest(csvFile(2000)))
    const first = send({ type: 'cancel' })
    const second = send({ type: 'cancel' })
    const replies3 = await Promise.all([reply(importId), reply(first), reply(second)])
    for (const r of replies3) expect(r.type).toBe('cancelled')
    expect(replies3[2]).toEqual(replies3[1])
  })

  it('a cancel that arrives while the last write settles cancels the import and deletes its rows', async () => {
    let cancelId: number | null = null
    vi.mocked(store.putAudit).mockImplementation(async (record) => {
      const real = (await vi.importActual<typeof import('../../src/worker/store')>('../../src/worker/store')).putAudit
      if (record.status === 'done' && cancelId === null) cancelId = send({ type: 'cancel' })
      return real(record)
    })
    try {
      const importId = send(importRequest(csvFile(50)))
      const res = await reply(importId)
      expect(res).toMatchObject({ type: 'cancelled', partialRowsDeleted: true })
      expect(cancelId).not.toBeNull()
      expect(await reply(cancelId!)).toEqual(res)
      expect(await store.listAuditIds()).toEqual([])
      const rows = await reply(send({ type: 'rows', offset: 0, limit: 10 }))
      expect(rows).toEqual({ type: 'rows', offset: 0, rows: [] })
    } finally {
      const real = await vi.importActual<typeof import('../../src/worker/store')>('../../src/worker/store')
      vi.mocked(store.putAudit).mockImplementation(real.putAudit)
    }
  })
})

describe('engine worker: quota errors', () => {
  it('says so when the partial rows could not be deleted', async () => {
    let cancelId: number | null = null
    vi.mocked(store.putRows).mockImplementationOnce(async () => {
      cancelId = send({ type: 'cancel' })
      throw new store.StoreQuotaError()
    })
    let failDelete = true
    vi.mocked(store.deleteAudit).mockImplementation(async (auditId) => {
      if (failDelete) throw new Error('delete refused')
      const real = await vi.importActual<typeof import('../../src/worker/store')>('../../src/worker/store')
      return real.deleteAudit(auditId)
    })
    try {
      const res = await reply(send(importRequest(csvFile(10))))
      expect(res.type).toBe('error')
      if (res.type !== 'error') return
      expect(res.code).toBe('quota')
      expect(res.message).toContain('Partial rows could not be deleted. Use Clear local data.')
      expect(res.message).not.toContain('Partial rows were deleted.')
      expect(cancelId).not.toBeNull()
      expect(await reply(cancelId!)).toMatchObject({ type: 'cancelled', partialRowsDeleted: false })
    } finally {
      failDelete = false
    }
  })

  it('says the partial rows were deleted when the delete worked', async () => {
    vi.mocked(store.putRows).mockImplementationOnce(async () => {
      throw new store.StoreQuotaError()
    })
    const res = await reply(send(importRequest(csvFile(10))))
    expect(res.type === 'error' && res.message).toMatch(/Partial rows were deleted\.$/)
  })
})

/** Every reply of one type to request `id`, in order. */
function repliesOf<T extends WorkerResponse['type']>(id: number, type: T): Extract<WorkerResponse, { type: T }>[] {
  return replies.filter((r) => r.id === id && r.response.type === type).map((r) => r.response as Extract<WorkerResponse, { type: T }>)
}

/** A stand-in for a FileSystemFileHandle: collects every write. */
function fakeHandle(opts: { failOnWrite?: number } = {}) {
  const writes: string[] = []
  const state = { closed: false, aborted: false, opened: 0 }
  const handle = {
    async createWritable() {
      state.opened++
      return {
        async write(data: string) {
          if (opts.failOnWrite !== undefined && writes.length === opts.failOnWrite) throw new DOMException('The disk is full.', 'QuotaExceededError')
          writes.push(data)
        },
        async close() {
          state.closed = true
        },
        async abort() {
          state.aborted = true
        },
      }
    },
  }
  return { handle, writes, state }
}

const SCENARIO_META = { file: TEST_META.file, date: TEST_META.date, sha256: TEST_META.sha256, commit: TEST_META.commit }
const NEUTRAL = {
  eligibleShare: '0.5',
  outputLengthRatio: '1',
  tokenizerRatio: '1',
  retryFallbackRate: '0',
  routingOverheadTokens: 0,
  calibrationPassRate: null,
}

function scenarioRequest(over: Partial<ScenarioRequest> = {}): WorkerRequest {
  return {
    type: 'scenario',
    request: {
      snapshot: TEST_SNAPSHOT,
      snapshotMeta: SCENARIO_META,
      baselineKey: null,
      routing: { sourceModels: [], inputBands: [], targetModel: 'gpt-4o', ...NEUTRAL },
      durationMap: DEFAULT_DURATION_MAP,
      ...over,
    },
  }
}

async function realStore() {
  return vi.importActual<typeof import('../../src/worker/store')>('../../src/worker/store')
}

describe('engine worker: CSV export to a file handle (stream path)', () => {
  it('writes the header, then one write per batch, closes the file and reports bytes, rows and progress', async () => {
    await importFile(csvFile(12000))
    const { handle, writes, state } = fakeHandle()
    const id = send({ type: 'exportCsv', target: handle })
    const res = await reply(id)
    expect(res.type).toBe('csv')
    if (res.type !== 'csv') return
    expect(res.path).toBe('stream')
    expect(res.blob).toBeNull()
    expect(res.rows).toBe(12000)
    expect(state).toEqual({ closed: true, aborted: false, opened: 1 })
    // Header, then batches of 5,000, 5,000 and 2,000 rows.
    expect(writes).toHaveLength(4)
    expect(writes[0]).toBe(CSV_HEADER)
    const text = writes.join('')
    expect(text.trimEnd().split('\r\n')).toHaveLength(12001)
    expect(res.bytes).toBe(Buffer.byteLength(text, 'utf8'))
    expect(res.ms).toBeGreaterThanOrEqual(0)
    const progress = repliesOf(id, 'exportProgress')
    expect(progress.map((p) => p.rows)).toEqual([5000, 10000, 12000])
    expect(progress[progress.length - 1]!.bytes).toBe(res.bytes)
  })

  it('aborts the file, never closes it, when an import starts during the export', async () => {
    await importFile(csvFile(12000))
    let next: number | null = null
    vi.mocked(store.iterateRows).mockImplementationOnce(async (auditId, size, cb) => {
      return (await realStore()).iterateRows(auditId, size, async (rows) => {
        if (next === null) {
          next = send(importRequest(csvFile(5)))
          await new Promise((r) => setTimeout(r, 20))
        }
        await cb(rows)
      })
    })
    const { handle, state } = fakeHandle()
    const res = await reply(send({ type: 'exportCsv', target: handle }))
    expect(res).toEqual({ type: 'error', code: 'internal', message: worker.EXPORT_STOPPED_BY_IMPORT })
    expect(state.closed).toBe(false)
    expect(state.aborted).toBe(true)
    expect((await reply(next!)).type).toBe('done')
  })

  it('aborts the file and replies with an error when a write fails', async () => {
    await importFile(csvFile(100))
    const { handle, state } = fakeHandle({ failOnWrite: 1 })
    const res = await reply(send({ type: 'exportCsv', target: handle }))
    expect(res).toEqual({ type: 'error', code: 'quota', message: 'The CSV export failed: The disk is full.' })
    expect(state).toMatchObject({ closed: false, aborted: true })
  })
})

describe('engine worker: CSV export fallback (Blob path)', () => {
  it('moves the text buffer into a Blob part each time it reaches 8 MiB', async () => {
    const rows = 30000
    await importFile(csvFile(rows))
    const RealBlob = globalThis.Blob
    const parts: number[] = []
    class SpyBlob extends RealBlob {
      constructor(blobParts?: BlobPart[], options?: BlobPropertyBag) {
        super(blobParts, options)
        // A part is one string buffer with no type.
        if (options === undefined && blobParts?.length === 1 && typeof blobParts[0] === 'string') parts.push(this.size)
      }
    }
    globalThis.Blob = SpyBlob
    let res: WorkerResponse
    const id = send({ type: 'exportCsv', target: null })
    try {
      res = await reply(id)
    } finally {
      globalThis.Blob = RealBlob
    }
    expect(res.type).toBe('csv')
    if (res.type !== 'csv') return
    expect(res.path).toBe('blob')
    expect(res.rows).toBe(rows)
    const blob = res.blob as Blob
    expect(blob.type).toBe('text/csv;charset=utf-8')
    expect(blob.size).toBe(res.bytes)
    expect(res.bytes).toBeGreaterThan(2 * EXPORT_PART_BYTES)
    expect(parts.length).toBeGreaterThanOrEqual(3)
    const text = await blob.text()
    const longestLine = Math.max(...text.split('\r\n').map((l) => Buffer.byteLength(l, 'utf8') + 2))
    // Every part but the last is at least 8 MiB and less than one more line; together they are the whole file.
    for (const size of parts.slice(0, -1)) {
      expect(size).toBeGreaterThanOrEqual(EXPORT_PART_BYTES)
      expect(size).toBeLessThan(EXPORT_PART_BYTES + longestLine)
    }
    expect(parts.reduce((a, b) => a + b, 0)).toBe(res.bytes)
    expect(text.startsWith(CSV_HEADER)).toBe(true)
    expect(text.trimEnd().split('\r\n')).toHaveLength(rows + 1)
    expect(repliesOf(id, 'exportProgress').map((p) => p.rows)).toEqual([5000, 10000, 15000, 20000, 25000, 30000])
  }, 120_000)

  it('counts UTF-8 bytes, not characters', () => {
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length('é')).toBe(2)
    expect(utf8Length('€')).toBe(3)
    expect(utf8Length('😀')).toBe(4)
    expect(utf8Length('\ud800x')).toBe(4)
    const s = 'a,é€😀\r\n'
    expect(utf8Length(s)).toBe(Buffer.byteLength(s, 'utf8'))
  })
})

describe('engine worker: savings scenario', () => {
  it('reprices every stored row in batches of 2,000 and returns the engine result', async () => {
    await importFile(csvFile(5000))
    const id = send(scenarioRequest({ baselineKey: 'gpt-4o' }))
    const res = await reply(id)
    expect(res.type).toBe('scenario')
    if (res.type !== 'scenario') return
    expect(repliesOf(id, 'scenarioProgress')).toEqual([
      { type: 'scenarioProgress', rowsDone: 2000, rowsTotal: 5000 },
      { type: 'scenarioProgress', rowsDone: 4000, rowsTotal: 5000 },
      { type: 'scenarioProgress', rowsDone: 5000, rowsTotal: 5000 },
    ])
    const r = res.result
    expect(r.rowsRead).toBe(5000)
    expect(r.quality).toBe('unverified')
    expect(r.snapshot).toEqual(SCENARIO_META)
    // The same model with neutral assumptions changes nothing.
    expect(r.routing?.savings.exactUsd).toMatch(/^0(\.0+)?$/)
    expect(r.routing?.savings.displayUsd).toBe('$0.000000')
    expect(r.routing?.scenario.exactUsd).toBe(r.listOriginal.exactUsd)
    expect(r.baseline?.difference.displayUsd).toBe('$0.000000')
  })

  it('a cheaper target gives the same result as the engine run directly on the same rows', async () => {
    await importFile(csvFile(3000))
    const routing = { sourceModels: ['gpt-4o'], inputBands: [], targetModel: 'gpt-4o-mini', ...NEUTRAL }
    const res = await reply(send(scenarioRequest({ routing })))
    expect(res.type).toBe('scenario')
    if (res.type !== 'scenario') return
    const real = await realStore()
    const [auditId] = await real.listAuditIds()
    const direct = createScenario({ snapshot: TEST_SNAPSHOT, snapshotMeta: SCENARIO_META, baselineKey: null, routing, durationMap: DEFAULT_DURATION_MAP })
    await real.iterateRows(auditId!, 777, (rows) => direct.add(rows))
    const want = direct.result(0)
    expect(res.result.routing).toEqual(want.routing)
    expect(res.result.listOriginal).toEqual(want.listOriginal)
    expect(res.result.routing!.eligibleRows).toBe(3000)
    expect(res.result.routing!.savings.exactUsd.startsWith('-')).toBe(false)
    expect(res.result.routing!.savings.exactUsd).not.toMatch(/^0(\.0+)?$/)
  })

  it('stops cleanly with an error when an import starts during the scenario', async () => {
    await importFile(csvFile(5000))
    let next: number | null = null
    vi.mocked(store.iterateRows).mockImplementationOnce(async (auditId, size, cb) => {
      return (await realStore()).iterateRows(auditId, size, async (rows) => {
        await cb(rows)
        if (next === null) {
          next = send(importRequest(csvFile(5)))
          await new Promise((r) => setTimeout(r, 20))
        }
      })
    })
    const res = await reply(send(scenarioRequest()))
    expect(res).toEqual({ type: 'error', code: 'internal', message: worker.SCENARIO_STOPPED_BY_IMPORT })
    expect((await reply(next!)).type).toBe('done')
  })

  it('stops cleanly with an error when local data is cleared during the scenario', async () => {
    await importFile(csvFile(5000))
    let cleared: number | null = null
    vi.mocked(store.iterateRows).mockImplementationOnce(async (auditId, size, cb) => {
      return (await realStore()).iterateRows(auditId, size, async (rows) => {
        if (cleared === null) {
          cleared = send({ type: 'clear' })
          await new Promise((r) => setTimeout(r, 20))
        }
        await cb(rows)
      })
    })
    const res = await reply(send(scenarioRequest()))
    expect(res).toEqual({ type: 'error', code: 'internal', message: worker.SCENARIO_STOPPED_BY_CLEAR })
    expect((await reply(cleared!)).type).toBe('cleared')
  })

  it('runs one scenario at a time', async () => {
    await importFile(csvFile(3000))
    const first = send(scenarioRequest())
    const second = send(scenarioRequest())
    expect(await reply(second)).toEqual({ type: 'error', code: 'internal', message: worker.SCENARIO_ALREADY_RUNNING })
    expect((await reply(first)).type).toBe('scenario')
    // Once the first is done, another may run.
    expect((await reply(send(scenarioRequest()))).type).toBe('scenario')
  })

  it('says so when no audit is open', async () => {
    expect(await reply(send(scenarioRequest()))).toEqual({ type: 'error', code: 'internal', message: 'There is no audit to model yet.' })
  })

  it('reports a bad assumption as an error', async () => {
    await importFile(csvFile(10))
    const res = await reply(send(scenarioRequest({ baselineKey: 'no-such-model' })))
    expect(res.type).toBe('error')
    expect(res.type === 'error' && res.message).toContain('no-such-model')
  })
})

describe('engine worker: row counts and cancelled audit ids', () => {
  it('counts the rows stored for an audit', async () => {
    const done = await importFile(csvFile(2345))
    expect(await reply(send({ type: 'countRows', auditId: done.summary.auditId }))).toEqual({ type: 'count', rows: 2345 })
    expect(await reply(send({ type: 'countRows', auditId: 'no-such-audit' }))).toEqual({ type: 'count', rows: 0 })
  })

  it('a cancelled import names its audit id, and that audit has no rows left', async () => {
    let started: string | null = null
    const gate = deferred<void>()
    vi.mocked(store.putRows).mockImplementationOnce(async (auditId, rows) => {
      started = auditId
      // Hold the first write until the cancel is sent, so the import cannot finish first.
      await gate.promise
      await (await realStore()).putRows(auditId, rows)
    })
    const importId = send(importRequest(csvFile(6000)))
    await vi.waitFor(() => {
      if (started === null) throw new Error('no rows written yet')
    }, { timeout: 20000, interval: 2 })
    const cancelId = send({ type: 'cancel' })
    gate.resolve()
    const [a, b] = await Promise.all([reply(importId), reply(cancelId)])
    expect(a).toMatchObject({ type: 'cancelled', auditId: started, partialRowsDeleted: true })
    expect(b).toEqual(a)
    expect(await reply(send({ type: 'countRows', auditId: started! }))).toEqual({ type: 'count', rows: 0 })
  })

  it('a cancel with no import running has no audit id', async () => {
    expect(await reply(send({ type: 'cancel' }))).toEqual({ type: 'cancelled', cancelMs: 0, deleteMs: 0, partialRowsDeleted: false, auditId: null })
  })
})

describe('engine worker: sample generation', () => {
  it('hashes the exact file bytes, padding included, and passes the generator stats on', async () => {
    const bytes = 300_000
    const seed = 7
    const gen = generateSampleChunks(bytes, seed)
    let step = gen.next()
    let text = ''
    while (!step.done) {
      text += step.value
      step = gen.next()
    }
    const stats = step.value
    expect(text.length).toBeLessThan(bytes)

    const res = await reply(send({ type: 'generateSample', bytes, seed }))
    expect(res.type).toBe('sample')
    if (res.type !== 'sample') return
    const file = res.file as File
    const fileBytes = new Uint8Array(await file.arrayBuffer())
    expect(file.size).toBe(bytes)
    expect(res.bytes).toBe(bytes)
    expect(res.sha256).toBe(createHash('sha256').update(fileBytes).digest('hex'))
    // The padding is in the hash: the generator text alone hashes differently.
    expect(res.sha256).not.toBe(createHash('sha256').update(text).digest('hex'))
    expect(new TextDecoder().decode(fileBytes)).toBe(text + '\n'.repeat(bytes - text.length))
    expect(res.seed).toBe(seed)
    expect(res.seed).toBe(stats.seed)
    expect(res.rows).toBe(stats.rows)
    expect(res.expectedNotPriced).toBe(stats.expectedNotPriced)
    expect(res.expectedUnresolved).toBe(stats.expectedUnresolved)
  })
})
