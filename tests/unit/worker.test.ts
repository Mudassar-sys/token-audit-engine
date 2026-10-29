import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CustomCsvMapping, DetectionResult, WorkerRequest, WorkerResponse } from '../../src/engine/contracts'
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

/** The first reply to request `id` that is not a progress message. */
async function reply(id: number): Promise<WorkerResponse> {
  return vi.waitFor(
    () => {
      const env = replies.find((r) => r.id === id && r.response.type !== 'progress' && r.response.type !== 'sampleProgress')
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

beforeAll(async () => {
  ;(globalThis as { self?: unknown }).self = fakeScope
  await import('../../src/worker/engine.worker')
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
    const res = await reply(send({ type: 'exportCsv' }))
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
    const res = await reply(send({ type: 'exportCsv' }))
    expect(res).toEqual({ type: 'error', code: 'internal', message: 'The CSV export stopped because a new import started. No file was saved.' })
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
    const res = await reply(send({ type: 'exportCsv' }))
    expect(res).toEqual({ type: 'error', code: 'internal', message: 'The CSV export stopped because local data was cleared. No file was saved.' })
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
    const res = await reply(send({ type: 'exportCsv' }))
    expect(res.type).toBe('error')
    expect(res.type === 'error' && res.message).toBe(`The CSV export read 5000 of ${done.summary.coverage.totalRows} rows, so no file was saved. Export again.`)
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
