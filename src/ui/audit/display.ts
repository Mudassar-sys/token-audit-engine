import type { AggregateBucket, AuditRow } from '../../engine/contracts'
import { displayUsd } from '../format'

/** Display text shared by the audit panels, the row table and the row drawer. */

export const UNRESOLVED_VALUE = 'Unresolved, review needed'
export const PARTIAL_TOTAL = 'partial total'
export const EXCLUDED_HEADING = 'Excluded from cost'

/** The value cell of one row. An Unresolved row says it needs review instead of showing an amount. */
export function rowValueText(row: Pick<AuditRow, 'cost'>): string {
  if (row.cost.label.kind === 'Unresolved') return UNRESOLVED_VALUE
  return displayUsd(row.cost.valueUsd)
}

/** True when a breakdown bucket's value leaves out Not priced or Unresolved rows. */
export function bucketIsPartial(b: AggregateBucket): boolean {
  return b.partial || b.rowsNotPriced + b.rowsUnresolved > 0
}

/** Value text of a breakdown bucket. A bucket where no row is priced has no value, never a zero. */
export function bucketValue(b: AggregateBucket): { text: string; partial: boolean } {
  return { text: displayUsd(b.valueUsd), partial: bucketIsPartial(b) }
}

/** A savings list-price figure. It is a partial total when any row was left out of the comparison. */
export function loggedValue(amount: { displayUsd: string }, leftOut: readonly { reason?: string; rows: number }[]): { text: string; partial: boolean } {
  return { text: amount.displayUsd, partial: leftOut.some((r) => r.rows > 0) }
}

export interface ExcludedGroup {
  label: string
  count: number
  /** Source keys summed into this group. */
  keys: string[]
}

/** Groups always listed, even at zero, so the reader sees what is never priced. */
const EXCLUDED_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Audio tokens', keys: ['input_audio', 'output_audio'] },
  { label: 'Image tokens', keys: ['input_image', 'output_image'] },
  { label: 'Web search requests', keys: ['web_search_requests'] },
  { label: 'Tool calls', keys: ['server_tool_calls', 'tool_calls', 'tool_sessions'] },
]

/** Groups listed only when the file has them. */
const OPTIONAL_GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Video tokens', keys: ['input_video', 'output_video'] },
  { label: 'Web fetch requests', keys: ['web_fetch_requests'] },
  { label: 'Storage', keys: ['storage'] },
]

/** Excluded-from-cost counts grouped for display. Unknown keys are listed under their own name. */
export function excludedGroups(excluded: Record<string, number>): ExcludedGroup[] {
  const used = new Set<string>()
  const sum = (keys: string[]) => keys.reduce((n, k) => {
    used.add(k)
    return n + (excluded[k] ?? 0)
  }, 0)
  const out: ExcludedGroup[] = EXCLUDED_GROUPS.map((g) => ({ label: g.label, keys: g.keys, count: sum(g.keys) }))
  for (const g of OPTIONAL_GROUPS) {
    const count = sum(g.keys)
    if (count > 0) out.push({ label: g.label, keys: g.keys, count })
  }
  for (const [k, v] of Object.entries(excluded)) {
    if (!used.has(k) && v > 0) out.push({ label: k, keys: [k], count: v })
  }
  return out
}
