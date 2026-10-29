import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { AuditRow, AuditSummary } from '../engine/contracts'

/**
 * Local row store in IndexedDB. Audit rows never leave the browser.
 * Rows are keyed by [auditId, rowIndex] so one audit reads back in stream order.
 */

export const DB_NAME = 'token-audit'
export const DB_VERSION = 1

export type StoredRow = AuditRow & { auditId: string }

export interface AuditRecord {
  auditId: string
  status: 'importing' | 'done'
  fileName: string
  startedAt: string
  summary: AuditSummary | null
}

interface AuditDb extends DBSchema {
  rows: { key: [string, number]; value: StoredRow }
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
        if (!db.objectStoreNames.contains('rows')) db.createObjectStore('rows', { keyPath: ['auditId', 'rowIndex'] })
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

function rowRange(auditId: string, from = -Infinity): IDBKeyRange {
  return IDBKeyRange.bound([auditId, from], [auditId, Infinity])
}

function stripAuditId(stored: StoredRow): AuditRow {
  const row: Partial<StoredRow> = { ...stored }
  delete row.auditId
  return row as AuditRow
}

/** Store one batch of rows in a single transaction. Throws StoreQuotaError when storage is full. */
export async function putRows(auditId: string, rows: readonly AuditRow[]): Promise<void> {
  if (rows.length === 0) return
  const db = await openStore()
  const tx = db.transaction('rows', 'readwrite')
  // Request errors surface through tx.done; swallow per-request rejections so none goes unhandled.
  const done = tx.done
  done.catch(() => undefined)
  try {
    for (const row of rows) tx.store.put({ ...row, auditId }).catch(() => undefined)
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
  const db = await openStore()
  const rows = await db.getAll('rows', rowRange(auditId, Math.max(0, offset)), limit)
  return rows.map(stripAuditId)
}

/** One row by its index, or null. */
export async function getRow(auditId: string, rowIndex: number): Promise<AuditRow | null> {
  const db = await openStore()
  const row = await db.get('rows', [auditId, rowIndex])
  return row ? stripAuditId(row) : null
}

/** Walk every row of an audit in order, one batch at a time. The callback may be async. */
export async function iterateRows(
  auditId: string,
  batchSize: number,
  cb: (rows: AuditRow[]) => void | Promise<void>,
): Promise<number> {
  const size = Math.max(1, Math.floor(batchSize))
  let next = 0
  let total = 0
  for (;;) {
    const db = await openStore()
    const batch = await db.getAll('rows', rowRange(auditId, next), size)
    if (batch.length === 0) break
    total += batch.length
    next = batch[batch.length - 1]!.rowIndex + 1
    await cb(batch.map(stripAuditId))
    if (batch.length < size) break
  }
  return total
}

/** Number of stored rows of one audit. */
export async function countRows(auditId: string): Promise<number> {
  const db = await openStore()
  return db.count('rows', rowRange(auditId))
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
  const tx = db.transaction(['rows', 'audits'], 'readwrite')
  await Promise.all([tx.objectStore('rows').delete(rowRange(auditId)), tx.objectStore('audits').delete(auditId), tx.done])
}

/** Delete the whole database. */
export async function clearAll(): Promise<void> {
  await closeStore()
  await deleteDB(DB_NAME)
}
