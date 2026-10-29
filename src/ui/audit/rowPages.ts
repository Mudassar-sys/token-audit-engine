/**
 * Page cache for the virtualized row table. Rows are fetched from the worker one page at a time,
 * and the main thread keeps only the pages around the visible rows. Pages further away are
 * dropped and fetched again when they come back into view.
 */

/** Pages kept on each side of the visible pages. */
export const KEEP_PAGES = 2

export class RowPageCache<T extends { rowIndex: number }> {
  private readonly pages = new Map<number, T[]>()
  private readonly requested = new Set<number>()

  constructor(
    private readonly fetchPage: (offset: number, limit: number) => Promise<T[]>,
    private readonly onChange: () => void,
    readonly pageSize = 100,
    readonly keep = KEEP_PAGES,
  ) {}

  /** Call when rows firstRow..lastRow are visible: drops far pages and fetches missing ones. */
  show(firstRow: number, lastRow: number): void {
    if (lastRow < 0) return
    const firstPage = Math.floor(firstRow / this.pageSize)
    const lastPage = Math.floor(lastRow / this.pageSize)
    const from = Math.max(0, firstPage - this.keep)
    const to = lastPage + this.keep
    let dropped = false
    for (const p of [...this.requested]) {
      if (p >= from && p <= to) continue
      this.requested.delete(p)
      dropped = this.pages.delete(p) || dropped
    }
    if (dropped) this.onChange()
    for (let p = firstPage; p <= lastPage; p++) {
      if (this.requested.has(p)) continue
      this.requested.add(p)
      this.fetchPage(p * this.pageSize, this.pageSize).then(
        (rows) => {
          // The page was dropped while it loaded: do not keep it.
          if (!this.requested.has(p)) return
          this.pages.set(p, rows)
          this.onChange()
        },
        () => this.requested.delete(p),
      )
    }
  }

  /** The row at index i, when its page is loaded. */
  rowAt(i: number): T | undefined {
    const page = this.pages.get(Math.floor(i / this.pageSize))
    return page?.find((r) => r.rowIndex === i) ?? page?.[i % this.pageSize]
  }

  /** Number of pages held in memory. */
  get size(): number {
    return this.pages.size
  }
}
