import { DEFAULT_DURATION_MAP, ENGINE_VERSION, type ScenarioRequest } from '../engine/contracts'
import type { EngineClient } from './engineClient'
import type { LoadedPricing } from './pricing'

/**
 * Benchmark runner on the main thread. Generates the synthetic 200MB file, imports it,
 * cancels at about half of the bytes, checks that no rows of the cancelled import are left,
 * imports it again to completion, runs a routing scenario over every row, then streams a CSV
 * export into the origin private file system and counts its records back.
 */

export const BENCHMARK_BYTES = 209_715_200
export const BENCHMARK_SEED = 20261029
/** Routing scenario of the run: every model, half of the rows, moved to this model. */
export const BENCHMARK_SCENARIO_TARGET = 'gpt-4o-mini'
export const BENCHMARK_SCENARIO_SHARE = '0.5'
/** Event timing entries shorter than this are not reported (16 ms is the lowest the browser allows). */
export const INTERACTION_DURATION_THRESHOLD_MS = 16
const STORAGE_KEY = 'token-audit:benchmark-results'
const KEEP_RESULTS = 20
export const NOT_AVAILABLE = 'not available' as const
export type NotAvailable = typeof NOT_AVAILABLE

export interface LongTaskStats { count: number; totalMs: number; maxMs: number }
/** Interactions (entries with an interactionId) and the longest input-to-next-paint duration. */
export interface InteractionStats { count: number; maxMs: number }

/** Phase of a running benchmark, exposed on window.__benchmarkPhase for automation. */
export type BenchmarkPhase = 'generate' | 'detect' | 'cancelled-import' | 'full-import' | 'scenario' | 'export' | 'done'

export interface BenchmarkResult {
  recordedAt: string
  engineVersion: string
  cpuCores: number | NotAvailable
  /** navigator.deviceMemory in GB, a rounded class, when the browser exposes it. */
  memoryClass: number | NotAvailable
  browser: string
  userAgent: string
  crossOriginIsolated: boolean
  /** PRNG seed of the generated file. */
  seed: number
  /** SHA-256 of the exact generated file bytes, padding included. */
  fileSha256: string
  fileBytes: number
  rows: number
  columns: number
  sourceMix: Record<string, number>
  sampleGenerationMs: number
  /** Pricing snapshot the import froze. */
  snapshotFile: string
  snapshotSha256: string
  /** Full import, start to summary. */
  totalMs: number
  rowsPerSecond: number
  importedRows: number
  /** Rows the generator wrote to be Not priced (unknown models) and Unresolved (spend 0 on a priced model). */
  expectedNotPriced: number
  expectedUnresolved: number
  /** What the import counted. */
  rowsNotPriced: number
  rowsUnresolved: number
  /** Peak bytes from performance.measureUserAgentSpecificMemory from the start until the full import ends. */
  peakMemory: number | NotAvailable
  /** Cancel response time: from the cancel request until processing stopped and in-flight writes settled (worker clock). */
  cancelMs: number
  /** Time spent deleting the partial rows after the stop. */
  partialDeleteMs: number
  /** From the cancel call to the confirmation, partial rows deleted, on the main thread. */
  cancelTotalMs: number
  cancelAtBytes: number
  partialRowsDeleted: boolean
  /** Rows of the cancelled import still stored after the cancel. */
  rowsAfterCancel: number | NotAvailable
  /** Long tasks of 50 ms or more on the main thread during the full import. */
  longTasks: LongTaskStats | NotAvailable
  /** Interactions during the full import, from event timing entries of 16 ms or more. */
  interactions: InteractionStats | NotAvailable
  /** Routing scenario over the imported rows, request to result, on the main thread. */
  scenarioMs: number
  scenarioRows: number
  /** How the CSV export was written: 'stream' into a file handle, or 'blob'. */
  exportPath: 'stream' | 'blob'
  exportBytes: number
  /** CSV export, request to confirmation, on the main thread. */
  exportMs: number
  /** Peak bytes from performance.measureUserAgentSpecificMemory during the export. */
  exportPeakMemory: number | NotAvailable
  /** Data records counted in the exported file, read back after the export. */
  exportedRows: number
}

/** Fields added after the first recorded results. Results recorded before them lack these. */
export type BenchmarkLaterField =
  | 'seed'
  | 'fileSha256'
  | 'snapshotFile'
  | 'snapshotSha256'
  | 'expectedNotPriced'
  | 'expectedUnresolved'
  | 'rowsNotPriced'
  | 'rowsUnresolved'
  | 'rowsAfterCancel'
  | 'interactions'
  | 'scenarioMs'
  | 'scenarioRows'
  | 'exportPath'
  | 'exportBytes'
  | 'exportMs'
  | 'exportPeakMemory'
  | 'exportedRows'
  | 'partialDeleteMs'
  | 'cancelTotalMs'

/** A result as stored or published. Older results can lack the later fields. */
export type StoredBenchmarkResult = Omit<BenchmarkResult, BenchmarkLaterField> & Partial<Pick<BenchmarkResult, BenchmarkLaterField>>

export interface BenchmarkDeps {
  client: EngineClient
  pricing: LoadedPricing
  onStatus?(text: string): void
  bytes?: number
}

interface UADataLike {
  getHighEntropyValues?(hints: string[]): Promise<{ fullVersionList?: { brand: string; version: string }[] }>
  brands?: { brand: string; version: string }[]
}

/** Browser name and version from client hints, else the user agent string. */
export async function describeBrowser(): Promise<string> {
  const nav = navigator as Navigator & { userAgentData?: UADataLike }
  try {
    const data = await nav.userAgentData?.getHighEntropyValues?.(['fullVersionList'])
    const list = (data?.fullVersionList ?? nav.userAgentData?.brands ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand))
    const specific = list.find((b) => !/^chromium$/i.test(b.brand)) ?? list[0]
    if (specific) return `${specific.brand} ${specific.version}`
  } catch {
    // Client hints refused; fall back below.
  }
  return navigator.userAgent
}

export function deviceInfo(): { cpuCores: number | NotAvailable; memoryClass: number | NotAvailable } {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    cpuCores: typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : NOT_AVAILABLE,
    memoryClass: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : NOT_AVAILABLE,
  }
}

function observes(type: string): boolean {
  return typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes ?? []).includes(type)
}

/** Counts long tasks (duration of 50 ms or more) while running. */
function startLongTaskObserver(): { stop(): LongTaskStats | NotAvailable } {
  if (!observes('longtask')) return { stop: () => NOT_AVAILABLE }
  const stats: LongTaskStats = { count: 0, totalMs: 0, maxMs: 0 }
  const take = (entries: PerformanceEntryList) => {
    for (const entry of entries) {
      if (entry.duration >= 50) {
        stats.count++
        stats.totalMs += entry.duration
        stats.maxMs = Math.max(stats.maxMs, entry.duration)
      }
    }
  }
  const observer = new PerformanceObserver((list) => take(list.getEntries()))
  try {
    observer.observe({ type: 'longtask', buffered: false })
  } catch {
    return { stop: () => NOT_AVAILABLE }
  }
  return {
    stop() {
      take(observer.takeRecords())
      observer.disconnect()
      return { count: stats.count, totalMs: Math.round(stats.totalMs), maxMs: Math.round(stats.maxMs) }
    },
  }
}

/**
 * Records interactions while running: event timing entries (input to next paint) of 16 ms or
 * more that belong to an interaction (interactionId above 0). count is distinct interactions.
 */
function startInteractionObserver(): { stop(): InteractionStats | NotAvailable } {
  if (!observes('event')) return { stop: () => NOT_AVAILABLE }
  const ids = new Set<number>()
  let maxMs = 0
  const take = (entries: PerformanceEntryList) => {
    for (const entry of entries) {
      const id = (entry as PerformanceEntry & { interactionId?: number }).interactionId ?? 0
      if (id > 0) {
        ids.add(id)
        maxMs = Math.max(maxMs, entry.duration)
      }
    }
  }
  const observer = new PerformanceObserver((list) => take(list.getEntries()))
  try {
    // durationThreshold is part of the event timing spec but not of every DOM type library.
    observer.observe({ type: 'event', buffered: false, durationThreshold: INTERACTION_DURATION_THRESHOLD_MS } as PerformanceObserverInit)
  } catch {
    return { stop: () => NOT_AVAILABLE }
  }
  return {
    stop() {
      take(observer.takeRecords())
      observer.disconnect()
      return { count: ids.size, maxMs: Math.round(maxMs) }
    },
  }
}

type MemoryMeasure = () => Promise<{ bytes: number }>

/** Samples page memory in a loop while cross-origin isolated; otherwise reports not available. */
function startMemorySampler(): { stop(): Promise<number | NotAvailable> } {
  const perf = performance as Performance & { measureUserAgentSpecificMemory?: MemoryMeasure }
  if (!globalThis.crossOriginIsolated || typeof perf.measureUserAgentSpecificMemory !== 'function') {
    return { stop: async () => NOT_AVAILABLE }
  }
  const measure = perf.measureUserAgentSpecificMemory.bind(perf)
  let peak = -1
  let running = true
  const loop = (async () => {
    while (running) {
      try {
        const m = await measure()
        if (typeof m.bytes === 'number') peak = Math.max(peak, m.bytes)
      } catch {
        return
      }
      if (running) await new Promise((r) => setTimeout(r, 250))
    }
  })()
  return {
    async stop() {
      running = false
      // A measurement can wait for the next collection; give it a bounded time to land.
      await Promise.race([loop, new Promise((r) => setTimeout(r, 30_000))])
      return peak >= 0 ? peak : NOT_AVAILABLE
    },
  }
}

/**
 * Streaming CSV record counter. Line breaks inside quoted cells do not end a record, an
 * escaped quote ("") toggles the quote state twice, CR LF counts once, and blank lines are
 * not records. Text can arrive split at any character.
 */
export function createCsvRecordCounter(): { push(text: string): void; finish(): number } {
  let inQuotes = false
  let content = false
  let records = 0
  return {
    push(text: string) {
      const n = text.length
      let i = 0
      let nextQuote = -2
      let nextLf = -2
      while (i < n) {
        if (inQuotes) {
          const q = text.indexOf('"', i)
          if (q === -1) return
          inQuotes = false
          i = q + 1
          continue
        }
        if (nextQuote !== -1 && nextQuote < i) nextQuote = text.indexOf('"', i)
        if (nextLf !== -1 && nextLf < i) nextLf = text.indexOf('\n', i)
        const end = nextQuote === -1 ? nextLf : nextLf === -1 ? nextQuote : Math.min(nextQuote, nextLf)
        const stop = end === -1 ? n : end
        if (!content) {
          for (let k = i; k < stop; k++) {
            if (text.charCodeAt(k) !== 13) {
              content = true
              break
            }
          }
        }
        if (end === -1) return
        if (end === nextQuote) {
          inQuotes = true
          content = true
        } else {
          if (content) records++
          content = false
        }
        i = end + 1
      }
    },
    finish() {
      if (content) records++
      content = false
      return records
    },
  }
}

/** Data records in a CSV file with a header row, read as a stream. */
export async function countCsvDataRows(file: Blob): Promise<number> {
  const counter = createCsvRecordCounter()
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    counter.push(value)
  }
  return Math.max(0, counter.finish() - 1)
}

/** Returns true at most once per interval, for status lines. */
function throttle(intervalMs: number): () => boolean {
  let last = -Infinity
  return () => {
    const now = performance.now()
    if (now - last < intervalMs) return false
    last = now
    return true
  }
}

function setPhase(phase: BenchmarkPhase): void {
  ;(globalThis as { __benchmarkPhase?: BenchmarkPhase }).__benchmarkPhase = phase
}

interface ExportMeasure {
  path: 'stream' | 'blob'
  bytes: number
  ms: number
  peakMemory: number | NotAvailable
  exportedRows: number
}

/**
 * Stream the open audit's CSV export into an origin private file system file (no save dialog
 * can run unattended), count its records back, then delete the file.
 */
async function measureExport(client: EngineClient, status: (text: string) => void): Promise<ExportMeasure> {
  if (typeof navigator.storage?.getDirectory !== 'function') {
    throw new Error('This browser has no origin private file system, so the export cannot be measured.')
  }
  const dir = await navigator.storage.getDirectory()
  const name = `benchmark-export-${Date.now()}.csv`
  const handle = await dir.getFileHandle(name, { create: true })
  try {
    const memory = startMemorySampler()
    const t0 = performance.now()
    let res: Awaited<ReturnType<EngineClient['exportCsv']>>
    try {
      const tick = throttle(1000)
      res = await client.exportCsv(handle, (p) => {
        if (tick()) status(`Exporting: ${p.rows.toLocaleString('en-US')} rows.`)
      })
    } catch (err) {
      await memory.stop()
      throw err
    }
    const ms = performance.now() - t0
    // Stop sampling before reading the file back, so the peak covers the export only.
    const peakMemory = await memory.stop()
    const written: Blob | null | undefined = res.path === 'blob' ? res.blob : await handle.getFile()
    const exportedRows = written ? await countCsvDataRows(written) : 0
    return { path: res.path, bytes: res.bytes, ms, peakMemory, exportedRows }
  } finally {
    await dir.removeEntry(name).catch(() => undefined)
  }
}

export async function runBenchmark(deps: BenchmarkDeps): Promise<BenchmarkResult> {
  const { client, pricing } = deps
  const status = deps.onStatus ?? (() => undefined)
  const bytes = deps.bytes ?? BENCHMARK_BYTES
  const memory = startMemorySampler()
  let memoryStopped = false
  try {
    setPhase('generate')
    status('Generating the synthetic file.')
    const sample = await client.generateSample(bytes, BENCHMARK_SEED, (b) => {
      status(`Generating the synthetic file: ${Math.floor((b / bytes) * 100)}%.`)
    })
    const file = new File([sample.file], sample.file.name || 'sample.csv', { type: 'text/csv' })

    setPhase('detect')
    status('Detecting the format.')
    const detection = await client.detect(file)
    if (!detection.variant) throw new Error(`The sample was not recognized: ${detection.reason}`)
    const request = {
      file,
      fileName: file.name,
      variant: detection.variant,
      detection,
      overridden: false,
      mapping: null,
      snapshot: pricing.snapshot,
      snapshotMeta: pricing.meta,
    }

    setPhase('cancelled-import')
    status('First import, to be cancelled at half of the bytes.')
    type CancelReply = Awaited<ReturnType<EngineClient['cancel']>> & { responseMs: number }
    let cancelCall: Promise<CancelReply> | null = null
    let cancelAtBytes = 0
    const first = await client.importFile(request, (p) => {
      if (cancelCall || p.bytesRead < p.bytesTotal / 2) return
      cancelAtBytes = p.bytesRead
      status('Cancelling the first import.')
      const t0 = performance.now()
      cancelCall = client.cancel().then((r) => ({ ...r, responseMs: performance.now() - t0 }))
    })
    if (first.kind !== 'cancelled' || !cancelCall) throw new Error('The first import finished before it could be cancelled.')
    const cancelled = await (cancelCall as Promise<CancelReply>)
    const cancelledAuditId = first.auditId ?? cancelled.auditId
    const rowsAfterCancel = cancelledAuditId ? await client.countRows(cancelledAuditId) : NOT_AVAILABLE

    setPhase('full-import')
    status('Second import, to completion.')
    const longTasks = startLongTaskObserver()
    const interactions = startInteractionObserver()
    const t0 = performance.now()
    let lastStatus = 0
    const second = await client.importFile(request, (p) => {
      const now = performance.now()
      if (now - lastStatus < 1000) return
      lastStatus = now
      status(`Importing: ${Math.floor((p.bytesRead / Math.max(1, p.bytesTotal)) * 100)}%, ${p.rows.toLocaleString('en-US')} rows.`)
    })
    const totalMs = performance.now() - t0
    const longTaskStats = longTasks.stop()
    const interactionStats = interactions.stop()
    if (second.kind !== 'done') throw new Error('The second import was cancelled.')
    const summary = second.summary
    if (summary.inputFileSha256 !== sample.sha256) {
      throw new Error('The imported file hash differs from the hash of the generated file.')
    }

    status('Measuring memory.')
    const peakMemory = await memory.stop()
    memoryStopped = true

    setPhase('scenario')
    status('Running the routing scenario over every row.')
    const frozen = summary.snapshot
    const scenarioRequest: ScenarioRequest = {
      snapshot: pricing.snapshot,
      snapshotMeta: { file: frozen.file, date: frozen.date, sha256: frozen.sha256, commit: frozen.commit },
      baselineKey: null,
      routing: {
        sourceModels: [],
        inputBands: [],
        targetModel: BENCHMARK_SCENARIO_TARGET,
        eligibleShare: BENCHMARK_SCENARIO_SHARE,
        outputLengthRatio: '1',
        tokenizerRatio: '1',
        retryFallbackRate: '0',
        routingOverheadTokens: 0,
        calibrationPassRate: null,
      },
      durationMap: DEFAULT_DURATION_MAP,
    }
    const s0 = performance.now()
    const scenarioTick = throttle(1000)
    const scenario = await client.scenario(scenarioRequest, (p) => {
      if (scenarioTick()) status(`Routing scenario: ${p.rowsDone.toLocaleString('en-US')} of ${p.rowsTotal.toLocaleString('en-US')} rows.`)
    })
    const scenarioMs = performance.now() - s0

    setPhase('export')
    status('Exporting the rows as CSV into the browser private file storage.')
    const exported = await measureExport(client, status)

    const device = deviceInfo()
    const importedRows = summary.coverage.totalRows
    const result: BenchmarkResult = {
      recordedAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
      cpuCores: device.cpuCores,
      memoryClass: device.memoryClass,
      browser: await describeBrowser(),
      userAgent: navigator.userAgent,
      crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
      seed: sample.seed,
      fileSha256: sample.sha256,
      fileBytes: sample.bytes,
      rows: sample.rows,
      columns: sample.columns,
      sourceMix: sample.sourceMix,
      sampleGenerationMs: Math.round(sample.ms),
      snapshotFile: frozen.file,
      snapshotSha256: frozen.sha256,
      totalMs: Math.round(totalMs),
      rowsPerSecond: Math.round(importedRows / Math.max(totalMs / 1000, 0.001)),
      importedRows,
      expectedNotPriced: sample.expectedNotPriced,
      expectedUnresolved: sample.expectedUnresolved,
      rowsNotPriced: summary.coverage.rowsNotPriced,
      rowsUnresolved: summary.coverage.rowsUnresolved,
      peakMemory,
      cancelMs: Math.round(cancelled.cancelMs),
      partialDeleteMs: Math.round(cancelled.deleteMs),
      cancelTotalMs: Math.round(cancelled.responseMs),
      cancelAtBytes,
      partialRowsDeleted: cancelled.partialRowsDeleted,
      rowsAfterCancel,
      longTasks: longTaskStats,
      interactions: interactionStats,
      scenarioMs: Math.round(scenarioMs),
      scenarioRows: scenario.rowsRead,
      exportPath: exported.path,
      exportBytes: exported.bytes,
      exportMs: Math.round(exported.ms),
      exportPeakMemory: exported.peakMemory,
      exportedRows: exported.exportedRows,
    }
    saveResult(result)
    ;(globalThis as { __benchmarkResult?: BenchmarkResult }).__benchmarkResult = result
    setPhase('done')
    status('Benchmark finished.')
    return result
  } finally {
    if (!memoryStopped) void memory.stop()
  }
}

/** Results recorded in this browser, newest last. */
export function loadSavedResults(): StoredBenchmarkResult[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as StoredBenchmarkResult[]) : []
  } catch {
    return []
  }
}

export function saveResult(result: BenchmarkResult): void {
  try {
    const all = [...loadSavedResults(), result].slice(-KEEP_RESULTS)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // Storage refused; the result still shows for this page view.
  }
}

export function clearSavedResults(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to clear.
  }
}

/** Recorded results shipped with the site. */
export async function loadRecordedResults(): Promise<StoredBenchmarkResult[]> {
  const res = await fetch('/benchmarks/results.json', { cache: 'no-cache', credentials: 'same-origin' })
  if (!res.ok) return []
  const data = (await res.json()) as { results?: unknown }
  return Array.isArray(data.results) ? (data.results as StoredBenchmarkResult[]) : []
}
