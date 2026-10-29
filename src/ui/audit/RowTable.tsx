import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { AuditRow } from '../../engine/contracts'
import type { EngineClient } from '../engineClient'
import { formatInt, sumCacheWrite } from '../format'
import { rowValueText } from './display'
import { RowPageCache } from './rowPages'

const PAGE = 100
const ROW_HEIGHT = 36
const COLUMNS = ['Row', 'Time (UTC)', 'Model', 'Provider', 'Tier', 'Uncached input', 'Cache read', 'Cache write', 'Output', 'Value', 'Label']

interface Props {
  client: EngineClient
  rowCount: number
  onOpen(rowIndex: number): void
}

/**
 * Virtualized, keyboard-operable row table. Only visible pages of rows are fetched from the worker,
 * and only pages near the visible rows stay in memory.
 * Arrow keys, Page Up, Page Down, Home and End move between rows; Enter or Space opens the explanation.
 * Mount it with key={auditId} so a new audit starts with an empty cache.
 */
export function RowTable({ client, rowCount, onOpen }: Props) {
  const ids = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const [, setVersion] = useState(0)
  const [cache] = useState(() => new RowPageCache<AuditRow>((offset, limit) => client.rows(offset, limit), () => setVersion((v) => v + 1), PAGE))
  const [active, setActive] = useState(0)
  const focusPending = useRef(false)
  const [headHeight, setHeadHeight] = useState(ROW_HEIGHT)

  useLayoutEffect(() => {
    if (headRef.current) setHeadHeight(headRef.current.offsetHeight)
  }, [])

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin: headHeight,
  })
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? -1

  useEffect(() => {
    cache.show(first, last)
  }, [first, last, cache])

  const rowAt = (i: number): AuditRow | undefined => cache.rowAt(i)

  useEffect(() => {
    if (!focusPending.current) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${active}"]`)
    if (el) {
      focusPending.current = false
      el.focus({ preventScroll: true })
    }
  })

  const moveTo = (i: number) => {
    const next = Math.max(0, Math.min(rowCount - 1, i))
    focusPending.current = true
    setActive(next)
    virtualizer.scrollToIndex(next, { align: 'auto' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    const pageRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? ROW_HEIGHT * 10) / ROW_HEIGHT) - 1)
    switch (e.key) {
      case 'ArrowDown':
        moveTo(i + 1)
        break
      case 'ArrowUp':
        moveTo(i - 1)
        break
      case 'PageDown':
        moveTo(i + pageRows)
        break
      case 'PageUp':
        moveTo(i - pageRows)
        break
      case 'Home':
        moveTo(0)
        break
      case 'End':
        moveTo(rowCount - 1)
        break
      case 'Enter':
      case ' ':
        onOpen(i)
        break
      default:
        return
    }
    e.preventDefault()
  }

  if (rowCount === 0) return <p>No rows were produced from this file.</p>

  return (
    <div className="row-grid-wrap">
      <p id={`${ids}-help`} className="hint">
        Use the arrow keys to move between rows and Enter to open a row's explanation.
      </p>
      <div
        ref={scrollRef}
        className="row-grid"
        role="grid"
        data-testid="row-table"
        aria-label="Audit rows"
        aria-describedby={`${ids}-help`}
        aria-rowcount={rowCount + 1}
        aria-colcount={COLUMNS.length}
      >
        <div role="rowgroup" className="row-grid-head" ref={headRef}>
          <div role="row" aria-rowindex={1} className="grid-row">
            {COLUMNS.map((c) => (
              <div role="columnheader" key={c} className="cell">
                {c}
              </div>
            ))}
          </div>
        </div>
        <div role="rowgroup" className="row-grid-body" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rowAt(item.index)
            return (
              <div
                key={item.key}
                role="row"
                aria-rowindex={item.index + 2}
                data-row-index={item.index}
                tabIndex={item.index === active ? 0 : -1}
                className="grid-row body-row"
                style={{ transform: `translateY(${item.start - headHeight}px)` }}
                onClick={() => {
                  setActive(item.index)
                  onOpen(item.index)
                }}
                onFocus={() => setActive(item.index)}
                onKeyDown={(e) => onKeyDown(e, item.index)}
              >
                {row ? <RowCells row={row} /> : <LoadingCells index={item.index} />}
              </div>
            )
          })}
        </div>
      </div>
      <p className="hint">{formatInt(rowCount)} rows. Rows are read from local storage as you scroll.</p>
    </div>
  )
}

/** A token count, or 'not measured' when the source did not log that class. Absent is never shown as 0. */
function tokenCell(row: AuditRow, cls: string, value: number): string {
  return row.notMeasured.some((n) => n === cls || n.startsWith(`${cls}.`)) ? 'not measured' : formatInt(value)
}

function RowCells({ row }: { row: AuditRow }) {
  const t = row.tokens
  const cells = [
    String(row.rowIndex + 1),
    row.timestamp ? row.timestamp.replace('T', ' ').replace(/\.\d+Z$|Z$/, '') : 'no time',
    row.modelLogged ?? 'no model',
    row.provider ?? 'unknown',
    row.tierStated ?? `${row.tierApplied} (assumed)`,
    tokenCell(row, 'uncachedInput', t.uncachedInput),
    tokenCell(row, 'cacheRead', t.cacheRead),
    tokenCell(row, 'cacheWrite', sumCacheWrite(t.cacheWrite)),
    tokenCell(row, 'output', t.output),
    rowValueText(row),
    row.counted ? row.cost.label.kind : `${row.cost.label.kind}, not in row counts or cost totals`,
  ]
  return (
    <>
      {cells.map((c, i) => (
        <div role="gridcell" key={i} className={i >= 5 && i <= 9 ? 'cell num' : 'cell'} data-label={i === 10 ? row.cost.label.kind : undefined}>
          {c}
        </div>
      ))}
    </>
  )
}

function LoadingCells({ index }: { index: number }) {
  return (
    <>
      <div role="gridcell" className="cell">
        {index + 1}
      </div>
      <div role="gridcell" className="cell loading">
        Loading
      </div>
      {COLUMNS.slice(2).map((c) => (
        <div role="gridcell" key={c} className="cell" />
      ))}
    </>
  )
}
