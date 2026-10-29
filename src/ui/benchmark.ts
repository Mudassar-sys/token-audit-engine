import { ENGINE_VERSION } from '../engine/contracts'
import type { EngineClient } from './engineClient'
import type { LoadedPricing } from './pricing'

/**
 * Benchmark runner on the main thread. Generates the synthetic 200MB file, imports it,
 * cancels at about half of the bytes, then imports it again to completion.
 */

export const BENCHMARK_BYTES = 209_715_200
export const BENCHMARK_SEED = 20261029
const STORAGE_KEY = 'token-audit:benchmark-results'
const KEEP_RESULTS = 20
const NOT_AVAILABLE = 'not available' as const

export interface LongTaskStats { count: number; totalMs: number; maxMs: number }

export interface BenchmarkResult {
  recordedAt: string
  engineVersion: string
  cpuCores: number | typeof NOT_AVAILABLE
  /** navigator.deviceMemory in GB, a rounded class, when the browser exposes it. */
  memoryClass: number | typeof NOT_AVAILABLE
  browser: string
  userAgent: string
  crossOriginIsolated: boolean
  fileBytes: number
  rows: number
  columns: number
  sourceMix: Record<string, number>
  sampleGenerationMs: number
  /** Full import, start to summary. */
  totalMs: number
  rowsPerSecond: number
  importedRows: number
  /** Peak bytes from performance.measureUserAgentSpecificMemory during the run. */
  peakMemory: number | typeof NOT_AVAILABLE
  /** Cancel response time: from the cancel request until processing stopped and in-flight writes settled (worker clock). */
  cancelMs: number
  /** Time spent deleting the partial rows after the stop. */
  partialDeleteMs: number
  /** From the cancel call to the confirmation, partial rows deleted, on the main thread. */
  cancelTotalMs: number
  cancelAtBytes: number
  partialRowsDeleted: boolean
  /** Long tasks of 50 ms or more on the main thread during the full import. */
  longTasks: LongTaskStats | typeof NOT_AVAILABLE
}

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

export function deviceInfo(): { cpuCores: number | typeof NOT_AVAILABLE; memoryClass: number | typeof NOT_AVAILABLE } {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return {
    cpuCores: typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : NOT_AVAILABLE,
    memoryClass: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : NOT_AVAILABLE,
  }
}

/** Counts long tasks (duration of 50 ms or more) while running. */
function startLongTaskObserver(): { stop(): LongTaskStats | typeof NOT_AVAILABLE } {
  const supported = typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes ?? []).includes('longtask')
  if (!supported) return { stop: () => NOT_AVAILABLE }
  const stats: LongTaskStats = { count: 0, totalMs: 0, maxMs: 0 }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration >= 50) {
        stats.count++
        stats.totalMs += entry.duration
        stats.maxMs = Math.max(stats.maxMs, entry.duration)
      }
    }
  })
  try {
    observer.observe({ type: 'longtask', buffered: false })
  } catch {
    return { stop: () => NOT_AVAILABLE }
  }
  return {
    stop() {
      for (const entry of observer.takeRecords()) {
        if (entry.duration >= 50) {
          stats.count++
          stats.totalMs += entry.duration
          stats.maxMs = Math.max(stats.maxMs, entry.duration)
        }
      }
      observer.disconnect()
      return { count: stats.count, totalMs: Math.round(stats.totalMs), maxMs: Math.round(stats.maxMs) }
    },
  }
}

type MemoryMeasure = () => Promise<{ bytes: number }>

/** Samples page memory in a loop while cross-origin isolated; otherwise reports not available. */
function startMemorySampler(): { stop(): Promise<number | typeof NOT_AVAILABLE> } {
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

export async function runBenchmark(deps: BenchmarkDeps): Promise<BenchmarkResult> {
  const { client, pricing } = deps
  const status = deps.onStatus ?? (() => undefined)
  const bytes = deps.bytes ?? BENCHMARK_BYTES
  const memory = startMemorySampler()
  let memoryStopped = false
  try {
    status('Generating the synthetic file.')
    const sample = await client.generateSample(bytes, BENCHMARK_SEED, (b) => {
      status(`Generating the synthetic file: ${Math.floor((b / bytes) * 100)}%.`)
    })
    const file = new File([sample.file], sample.file.name || 'sample.csv', { type: 'text/csv' })

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

    status('First import, to be cancelled at half of the bytes.')
    let cancelCall: Promise<{ cancelMs: number; deleteMs: number; partialRowsDeleted: boolean; responseMs: number }> | null = null
    let cancelAtBytes = 0
    const first = await client.importFile(request, (p) => {
      if (cancelCall || p.bytesRead < p.bytesTotal / 2) return
      cancelAtBytes = p.bytesRead
      status('Cancelling the first import.')
      const t0 = performance.now()
      cancelCall = client.cancel().then((r) => ({ ...r, responseMs: performance.now() - t0 }))
    })
    if (first.kind !== 'cancelled' || !cancelCall) throw new Error('The first import finished before it could be cancelled.')
    const cancelled = await (cancelCall as Promise<{ cancelMs: number; deleteMs: number; partialRowsDeleted: boolean; responseMs: number }>)

    status('Second import, to completion.')
    const longTasks = startLongTaskObserver()
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
    if (second.kind !== 'done') throw new Error('The second import was cancelled.')

    status('Measuring memory.')
    const peakMemory = await memory.stop()
    memoryStopped = true
    const device = deviceInfo()
    const importedRows = second.summary.coverage.totalRows
    const result: BenchmarkResult = {
      recordedAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
      cpuCores: device.cpuCores,
      memoryClass: device.memoryClass,
      browser: await describeBrowser(),
      userAgent: navigator.userAgent,
      crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
      fileBytes: sample.bytes,
      rows: sample.rows,
      columns: sample.columns,
      sourceMix: sample.sourceMix,
      sampleGenerationMs: Math.round(sample.ms),
      totalMs: Math.round(totalMs),
      rowsPerSecond: Math.round(importedRows / Math.max(totalMs / 1000, 0.001)),
      importedRows,
      peakMemory,
      cancelMs: Math.round(cancelled.cancelMs),
      partialDeleteMs: Math.round(cancelled.deleteMs),
      cancelTotalMs: Math.round(cancelled.responseMs),
      cancelAtBytes,
      partialRowsDeleted: cancelled.partialRowsDeleted,
      longTasks: longTaskStats,
    }
    saveResult(result)
    ;(globalThis as { __benchmarkResult?: BenchmarkResult }).__benchmarkResult = result
    status('Benchmark finished.')
    return result
  } finally {
    if (!memoryStopped) void memory.stop()
  }
}

/** Results recorded in this browser, newest last. */
export function loadSavedResults(): BenchmarkResult[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as BenchmarkResult[]) : []
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
export async function loadRecordedResults(): Promise<BenchmarkResult[]> {
  const res = await fetch('/benchmarks/results.json', { cache: 'no-cache', credentials: 'same-origin' })
  if (!res.ok) return []
  const data = (await res.json()) as { results?: unknown }
  return Array.isArray(data.results) ? (data.results as BenchmarkResult[]) : []
}
