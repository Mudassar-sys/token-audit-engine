import type { ParsedElementInfo } from '@streamparser/json'
import type { RawRecord } from '../adapters/types'
import { RECORD_BATCH } from './reader'

/**
 * Selectors for span-level traversal of one OTLP JSON export request. Each span is emitted on
 * its own, and the resource and scope of its group are emitted separately, so the parser never
 * holds more than one span (keepStack is off). The legacy instrumentationLibrarySpans names are
 * read too.
 */
export const OTLP_SPAN_PATH = '$.resourceSpans.*.scopeSpans.*.spans.*'
export const OTLP_EXTRA_PATHS = [
  '$.resourceSpans.*.resource',
  '$.resourceSpans.*.scopeSpans.*.scope',
  '$.resourceSpans.*.instrumentationLibrarySpans.*.spans.*',
  '$.resourceSpans.*.instrumentationLibrarySpans.*.instrumentationLibrary',
] as const

/** Spans held while waiting for a resource that comes after them in the document. */
export const OTLP_PENDING_LIMIT = RECORD_BATCH

interface HeldSpan {
  scopeIndex: number
  span: unknown
}

/**
 * Turns span-level parser values into records the OTel adapter reads as it reads a whole export
 * request: one record per span, shaped `{ resourceSpans: [{ resource, scopeSpans: [{ scope, spans: [span] }] }] }`.
 * The resource and scope objects are shared between the records of one group, not copied.
 *
 * Exporters write `resource` before `scopeSpans`. When a document puts it after, spans are held
 * (at most OTLP_PENDING_LIMIT) until it arrives; past that limit, or when the group ends without
 * one, they are emitted without a resource.
 */
export class OtlpSpanAssembler {
  private group: number | null = null
  private resource: unknown = undefined
  private hasResource = false
  private scopes = new Map<number, unknown>()
  private held: HeldSpan[] = []

  /** Records for one parser value. Reads info.stack synchronously. */
  value(info: ParsedElementInfo): RawRecord[] {
    const { stack, key, value } = info
    const group = stack[2]?.key
    if (stack[1]?.key !== 'resourceSpans' || typeof group !== 'number') return []
    const out: RawRecord[] = []
    if (group !== this.group) {
      this.release(out)
      this.group = group
      this.resource = undefined
      this.hasResource = false
      this.scopes.clear()
    }
    if (stack.length === 3 && key === 'resource') {
      this.resource = value
      this.hasResource = true
      this.release(out)
    } else if (stack.length === 5 && (key === 'scope' || key === 'instrumentationLibrary')) {
      const scopeIndex = stack[4]?.key
      if (typeof scopeIndex === 'number') this.scopes.set(scopeIndex, value)
    } else if (stack.length === 6 && typeof key === 'number') {
      const scopeIndex = stack[4]?.key
      if (typeof scopeIndex !== 'number') return out
      if (this.hasResource) {
        out.push(this.record(scopeIndex, value))
      } else {
        this.held.push({ scopeIndex, span: value })
        if (this.held.length >= OTLP_PENDING_LIMIT) this.release(out)
      }
    }
    return out
  }

  /** Records still held at the end of the document. */
  end(): RawRecord[] {
    const out: RawRecord[] = []
    this.release(out)
    return out
  }

  private release(out: RawRecord[]): void {
    for (const h of this.held) out.push(this.record(h.scopeIndex, h.span))
    this.held = []
  }

  private record(scopeIndex: number, span: unknown): RawRecord {
    const scopeSpans: Record<string, unknown> = { spans: [span] }
    if (this.scopes.has(scopeIndex)) scopeSpans.scope = this.scopes.get(scopeIndex)
    const group: Record<string, unknown> = { scopeSpans: [scopeSpans] }
    if (this.hasResource) group.resource = this.resource
    return { kind: 'json', value: { resourceSpans: [group] }, line: null }
  }
}
