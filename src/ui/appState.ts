import type { AuditSummary, CustomCsvMapping, DetectionResult, Progress, VariantId } from '../engine/contracts'
import { EngineError } from './engineClient'
import type { LoadedPricing } from './pricing'

export const PRIVACY_LINE = 'Log content and audit values are not uploaded.'
export const SAMPLE_BYTES = 209_715_200

export interface OpenAudit {
  summary: AuditSummary
  /** The snapshot this audit was priced with. A newer snapshot never recalculates it. */
  pricing: LoadedPricing
}

export type Notice = { kind: 'error' | 'info'; text: string } | null

export interface ImportState {
  file: File | null
  detection: DetectionResult | null
  detecting: boolean
  override: VariantId | null
  mapping: CustomCsvMapping | null
  phase: 'idle' | 'running' | 'cancelling'
  progress: Progress | null
  sampleBytes: number | null
  notice: Notice
}

export const initialImport: ImportState = {
  file: null,
  detection: null,
  detecting: false,
  override: null,
  mapping: null,
  phase: 'idle',
  progress: null,
  sampleBytes: null,
  notice: null,
}

export function effectiveVariant(s: ImportState): VariantId | null {
  return s.override ?? s.detection?.variant ?? null
}

export function errorText(err: unknown): string {
  if (err instanceof EngineError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}
