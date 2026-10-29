import type { PricingModelEntry } from './contracts'

/**
 * Model name resolution against the pricing snapshot.
 * Exact key match first, then the ALIASES table only. Never strip dated
 * suffixes or provider prefixes: a name without an exact key or alias is Not priced.
 */

export interface ModelAlias {
  from: string
  to: string
  /** Where the equivalence of the two names and their prices is documented. */
  source: string
  note: string
}

export const ALIASES: readonly ModelAlias[] = [
  {
    from: 'openai/gpt-4o',
    to: 'gpt-4o',
    source: 'https://openrouter.ai/api/v1/models',
    note:
      'The OpenRouter models API lists the same prompt, completion and cache-read prices as the registry entry gpt-4o and https://developers.openai.com/api/docs/pricing',
  },
  {
    from: 'openai/gpt-4o-mini',
    to: 'gpt-4o-mini',
    source: 'https://openrouter.ai/api/v1/models',
    note:
      'The OpenRouter models API lists the same prompt, completion and cache-read prices as the registry entry gpt-4o-mini and https://developers.openai.com/api/docs/pricing',
  },
]

const ALIAS_BY_FROM = new Map(ALIASES.map((a) => [a.from, a]))

export type MatchKind = 'exact' | 'alias' | 'none'

export interface Resolution {
  key: string | null
  match: { kind: MatchKind; detail: string; source: string | null }
}

/** Resolve a logged model name to a snapshot key. */
export function resolveModel(modelLogged: string | null, models: Readonly<Record<string, PricingModelEntry>>): Resolution {
  if (modelLogged === null || modelLogged === '') {
    return { key: null, match: { kind: 'none', detail: 'no model name in the row', source: null } }
  }
  if (Object.hasOwn(models, modelLogged)) {
    return { key: modelLogged, match: { kind: 'exact', detail: `exact key "${modelLogged}" in the snapshot`, source: null } }
  }
  const alias = ALIAS_BY_FROM.get(modelLogged)
  if (alias && Object.hasOwn(models, alias.to)) {
    return {
      key: alias.to,
      match: { kind: 'alias', detail: `alias "${alias.from}" to "${alias.to}": ${alias.note}`, source: alias.source },
    }
  }
  return {
    key: null,
    match: {
      kind: 'none',
      detail: `no exact key "${modelLogged}" in the snapshot and no alias; names are never shortened or guessed`,
      source: null,
    },
  }
}
