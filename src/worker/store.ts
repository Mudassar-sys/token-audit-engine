import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { AuditRow, AuditSummary } from '../engine/contracts'

/**
 * Local row store in IndexedDB. Audit rows never leave the browser.
 * Rows are kept in chunks: one record per contiguous run of rows, keyed by [auditId, first rowIndex].
 * A 200 MB import then writes and deletes a few hundred records instead of hundreds of thousands.
 */

export const DB_NAME = 'token-audit'
export const DB_VERSION = 2

/** One stored chunk: rows first..last of one audit, in order. */
export interface RowChunk {
  auditId: string
  first: number
  last: number
  rows: AuditRow[]
}

export interface AuditRecord {
  auditId: string
  status: 'importing' | 'done'
  fileName: string
  startedAt: string
  summary: AuditSummary | null
}

interface AuditDb extends DBSchema {
  chunks: { key: [string, number]; value: RowChunk }
  audits: { key: string; value: AuditRecord }
}

/** Raised when the browser refuses a write because local storage is full. */
export class StoreQuotaError extends Error {
  readonly code = 'quota' as const
  constructor(cause?: unknown) {
    super('Local storage is full. The browser refused to store more audit rows. Clear local data or use a smaller file.', { cause })
    this.name = 'StoreQuotaError'
  }
}

/** True when an error (or the error it wraps) is a browser quota error. Checks the name, not the class. */
export function isQuotaError(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; depth < 4 && cur; depth++) {
    if (cur instanceof StoreQuotaError) return true
    const name = (cur as { name?: unknown }).name
    if (name === 'QuotaExceededError') return true
    cur = (cur as { cause?: unknown; error?: unknown }).cause ?? (cur as { error?: unknown }).error
  }
  return false
}

/** Map any store error to StoreQuotaError when it is a quota error, else return it unchanged. */
export function mapStoreError(err: unknown): unknown {
  if (err instanceof StoreQuotaError) return err
  return isQuotaError(err) ? new StoreQuotaError(err) : err
}

let dbPromise: Promise<IDBPDatabase<AuditDb>> | null = null

/** Open (or reuse) the database connection. */
export function openStore(): Promise<IDBPDatabase<AuditDb>> {
  if (!dbPromise) {
    dbPromise = openDB<AuditDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Version 1 kept one record per row. Those rows are local scratch data, so the old store is dropped.
        const raw = db as unknown as IDBDatabase
        if (raw.objectStoreNames.contains('rows')) raw.deleteObjectStore('rows')
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['auditId', 'first'] })
        if (!db.objectStoreNames.contains('audits')) db.createObjectStore('audits', { keyPath: 'auditId' })
      },
      blocking() {
        // Another connection wants to delete or upgrade the database: step aside.
        void closeStore()
      },
      terminated() {
        dbPromise = null
      },
    })
    dbPromise.catch(() => {
      dbPromise = null
    })
  }
  return dbPromise
}

/** Close the shared connection, if open. */
export async function closeStore(): Promise<void> {
  const p = dbPromise
  dbPromise = null
  if (!p) return
  try {
    ;(await p).close()
  } catch {
    // The connection never opened; nothing to close.
  }
}

function chunkRange(auditId: string, from = -Infinity, to = Infinity): IDBKeyRange {
  return IDBKeyRange.bound([auditId, from], [auditId, to])
}

/** Split rows into runs of consecutive rowIndex values. */
function contiguousRuns(rows: readonly AuditRow[]): AuditRow[][] {
  const sorted = [...rows].sort((a, b) => a.rowIndex - b.rowIndex)
  const runs: AuditRow[][] = []
  for (const row of sorted) {
    const run = runs[runs.length - 1]
    if (run && run[run.length - 1]!.rowIndex + 1 === row.rowIndex) run.push(row)
    else runs.push([row])
  }
  return runs
}

/** Store one batch of rows in a single transaction. Throws StoreQuotaError when storage is full. */
export async function putRows(auditId: string, rows: readonly AuditRow[]): Promise<void> {
  if (rows.length === 0) return
  const db = await openStore()
  const tx = db.transaction('chunks', 'readwrite')
  // Request errors surface through tx.done; swallow per-request rejections so none goes unhandled.
  const done = tx.done
  done.catch(() => undefined)
  try {
    for (const run of contiguousRuns(rows)) {
      tx.store.put({ auditId, first: run[0]!.rowIndex, last: run[run.length - 1]!.rowIndex, rows: run }).catch(() => undefined)
    }
    await done
  } catch (err) {
    try {
      tx.abort()
    } catch {
      // Already finished or aborted.
    }
    throw mapStoreError(err)
  }
}

/** Rows of one audit starting at rowIndex `offset`, at most `limit`, in row order. */
export async function getRows(auditId: string, offset: number, limit: number): Promise<AuditRow[]> {
  if (limit <= 0) return []
  const from = Math.max(0, offset)
  const db = await openStore()
  const tx = db.transaction('chunks', 'readonly')
  const out: AuditRow[] = []
  // The chunk holding `from` starts at or before it.
  const before = await tx.store.openCursor(chunkRange(auditId, -Infinity, from), 'prev')
  let cursor = await tx.store.openCursor(chunkRange(auditId, before ? before.value.first : from))
  while (cursor && out.length < limit) {
    for (const row of cursor.value.rows) {
      if (row.rowIndex < from) continue
      out.push(row)
      if (out.length >= limit) break
    }
    cursor = out.length < limit ? await cursor.continue() : null
  }
  await tx.done
  return out
}

/** One row by its index, or null. */
export async function getRow(auditId: string, rowIndex: number): Promise<AuditRow | null> {
  const [row] = await getRows(auditId, rowIndex, 1)
  return row && row.rowIndex === rowIndex ? row : null
}

/** Chunks read per step while iterating, which keeps memory bounded. */
const ITERATE_CHUNKS = 4

/** Walk every row of an audit in order, `batchSize` rows at a time (the last batch may be smaller). */
export async function iterateRows(
  auditId: string,
  batchSize: number,
  cb: (rows: AuditRow[]) => void | Promise<void>,
): Promise<number> {
  const size = Math.max(1, Math.floor(batchSize))
  let next = -Infinity
  let total = 0
  let pending: AuditRow[] = []
  for (;;) {
    const db = await openStore()
    // The read transaction ends before the callback runs, so a slow callback never holds it open.
    const chunks = await db.getAll('chunks', chunkRange(auditId, next), ITERATE_CHUNKS)
    if (chunks.length === 0) break
    for (const chunk of chunks) {
      pending.push(...chunk.rows)
      next = chunk.first + 1
      while (pending.length >= size) {
        const batch = pending.slice(0, size)
        pending = pending.slice(size)
        total += batch.length
        await cb(batch)
      }
    }
    if (chunks.length < ITERATE_CHUNKS) break
  }
  if (pending.length > 0) {
    total += pending.length
    await cb(pending)
  }
  return total
}

/** Number of stored rows of one audit. */
export async function countRows(auditId: string): Promise<number> {
  const db = await openStore()
  const tx = db.transaction('chunks', 'readonly')
  let n = 0
  let cursor = await tx.store.openCursor(chunkRange(auditId))
  while (cursor) {
    n += cursor.value.last - cursor.value.first + 1
    cursor = await cursor.continue()
  }
  await tx.done
  return n
}

export async function putAudit(record: AuditRecord): Promise<void> {
  const db = await openStore()
  try {
    await db.put('audits', record)
  } catch (err) {
    throw mapStoreError(err)
  }
}

export async function getAudit(auditId: string): Promise<AuditRecord | null> {
  const db = await openStore()
  return (await db.get('audits', auditId)) ?? null
}

export async function listAuditIds(): Promise<string[]> {
  const db = await openStore()
  return db.getAllKeys('audits')
}

/** Delete an audit record and all of its rows. */
export async function deleteAudit(auditId: string): Promise<void> {
  const db = await openStore()
  const tx = db.transaction(['chunks', 'audits'], 'readwrite')
  await Promise.all([tx.objectStore('chunks').delete(chunkRange(auditId)), tx.objectStore('audits').delete(auditId), tx.done])
}

/** Delete the whole database. */
export async function clearAll(): Promise<void> {
  await closeStore()
  await deleteDB(DB_NAME)
}
