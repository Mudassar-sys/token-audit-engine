import { formatUsd, usdToFemto } from '../engine/money'

/** Display helpers. Money display always goes through BigInt, never a float. */

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} bytes`
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  return `${Math.round(ms)} ms`
}

/** Exact decimal USD text to a display string, or a dash when there is no value. */
export function displayUsd(exact: string | null, decimals = 6): string {
  if (exact === null) return 'no value'
  try {
    return formatUsd(usdToFemto(exact), decimals)
  } catch {
    return exact
  }
}

export function sumCacheWrite(w: { '5m': number; '1h': number; '30m': number; '12h': number }): number {
  return w['5m'] + w['1h'] + w['30m'] + w['12h']
}

/** Stringify an unknown raw value for display. */
export function rawText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined) return 'undefined'
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
