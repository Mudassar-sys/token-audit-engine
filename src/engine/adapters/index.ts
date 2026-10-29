import type { SourceId, VariantId } from '../contracts'
import type { StreamFormat } from '../stream'
import { anthropicAdapter } from './anthropic'
import { customCsvAdapter } from './customCsv'
import { litellmAdapter } from './litellm'
import { openaiChatAdapter } from './openaiChat'
import { openaiResponsesAdapter } from './openaiResponses'
import { openaiUsageAdapter } from './openaiUsage'
import { openrouterAdapter } from './openrouter'
import { otelAdapter } from './otel'
import type { Adapter } from './types'

/** Every adapter, in the order candidates are listed and ties are broken. */
export const ADAPTERS: readonly Adapter[] = [
  openaiChatAdapter,
  openaiResponsesAdapter,
  openaiUsageAdapter,
  anthropicAdapter,
  openrouterAdapter,
  litellmAdapter,
  otelAdapter,
  customCsvAdapter,
]

export interface VariantInfo {
  id: VariantId
  source: SourceId
  /** Plain label shown in the supported variants list. */
  label: string
  /** Container format the stream reader uses for this variant. */
  format: StreamFormat
  /** Fixture file in fixtures/ that exercises this variant. */
  fixture: string
}

/** The exact list of supported inputs. Anything else is "not supported yet". */
export const VARIANTS: readonly VariantInfo[] = [
  { id: 'A-json', source: 'A', label: 'OpenAI Chat Completions responses, JSON array', format: 'json-array', fixture: 'a-openai-chat.json' },
  { id: 'A-jsonl', source: 'A', label: 'OpenAI Chat Completions responses, JSONL', format: 'jsonl', fixture: 'a-openai-chat.jsonl' },
  { id: 'B-json', source: 'B', label: 'OpenAI Responses API responses, JSON array', format: 'json-array', fixture: 'b-openai-responses.json' },
  { id: 'B-jsonl', source: 'B', label: 'OpenAI Responses API responses, JSONL', format: 'jsonl', fixture: 'b-openai-responses.jsonl' },
  { id: 'C-page', source: 'C', label: 'OpenAI Usage API completions page, JSON', format: 'usage-page', fixture: 'c-openai-usage-page.json' },
  { id: 'D-json', source: 'D', label: 'Anthropic Messages API responses, JSON array', format: 'json-array', fixture: 'd-anthropic-messages.json' },
  { id: 'D-jsonl', source: 'D', label: 'Anthropic Messages API responses, JSONL', format: 'jsonl', fixture: 'd-anthropic-messages.jsonl' },
  { id: 'E-json', source: 'E', label: 'OpenRouter responses with usage accounting, JSON array', format: 'json-array', fixture: 'e-openrouter.json' },
  { id: 'E-jsonl', source: 'E', label: 'OpenRouter responses with usage accounting, JSONL', format: 'jsonl', fixture: 'e-openrouter.jsonl' },
  { id: 'F-csv', source: 'F', label: 'LiteLLM spend logs, CSV', format: 'csv', fixture: 'f-litellm-spend.csv' },
  { id: 'F-json', source: 'F', label: 'LiteLLM spend logs, JSON array', format: 'json-array', fixture: 'f-litellm-spend.json' },
  { id: 'G-otlp', source: 'G', label: 'OpenTelemetry GenAI spans, OTLP JSON export request', format: 'otlp', fixture: 'g-otel-spans.json' },
  { id: 'G-otlp-jsonl', source: 'G', label: 'OpenTelemetry GenAI spans, one OTLP JSON export request per line', format: 'otlp-jsonl', fixture: 'g-otel-spans.jsonl' },
  { id: 'H-csv', source: 'H', label: 'Any other CSV, through a column mapping', format: 'csv', fixture: 'h-custom.csv' },
]

/** The adapter that reads a variant. */
export function adapterForVariant(v: VariantId): Adapter {
  const adapter = ADAPTERS.find((a) => a.variants.includes(v))
  if (!adapter) throw new Error(`No adapter for variant ${v}`)
  return adapter
}

/** Display info for a variant. */
export function variantInfo(v: VariantId): VariantInfo {
  const info = VARIANTS.find((x) => x.id === v)
  if (!info) throw new Error(`Unknown variant ${v}`)
  return info
}
