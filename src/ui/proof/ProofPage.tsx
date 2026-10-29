import type { EngineClient } from '../engineClient'
import type { LoadedPricing } from '../pricing'
import { BenchmarkPage } from './BenchmarkPage'
import { MethodologyPage } from './MethodologyPage'
import { PrivacyPanel } from './PrivacyPanel'

type ProofSub = 'benchmark' | 'methodology' | 'privacy'

interface Props {
  page: ProofSub
  client: EngineClient
  pricing: LoadedPricing | null
  importBusy: boolean
  onBenchmarkStart(): void
  onBenchmarkEnd(): void
}

const SUBS: { key: ProofSub; label: string }[] = [
  { key: 'benchmark', label: 'Benchmark' },
  { key: 'methodology', label: 'Methodology' },
  { key: 'privacy', label: 'Privacy' },
]

export function ProofPage({ page, client, pricing, importBusy, onBenchmarkStart, onBenchmarkEnd }: Props) {
  return (
    <div className="page">
      <h1>Proof</h1>
      <nav aria-label="Proof pages">
        <ul className="subnav">
          {SUBS.map((s) => (
            <li key={s.key}>
              <a href={`#/proof/${s.key}`} aria-current={page === s.key ? 'page' : undefined}>
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {page === 'benchmark' && (
        <BenchmarkPage client={client} pricing={pricing} importBusy={importBusy} onStart={onBenchmarkStart} onEnd={onBenchmarkEnd} />
      )}
      {page === 'methodology' && <MethodologyPage />}
      {page === 'privacy' && <PrivacyPanel />}
    </div>
  )
}
