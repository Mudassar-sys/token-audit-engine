# Token Audit Engine

[![CI](https://github.com/Mudassar-sys/token-audit-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/Mudassar-sys/token-audit-engine/actions/workflows/ci.yml)

Built as a working demonstration for a token-cost audit requirement.

A browser-only app that reads model usage logs, prices every row by token class, and explains each number. Log content and audit values are not uploaded.

## What the tests and the benchmark prove

Each claim below is backed by a passing test in this repository or by the recorded benchmark in [BENCHMARK.md](BENCHMARK.md).

- **Large files stay responsive.** A 200 MB synthetic log is generated, imported, cancelled midway and imported again in the browser. In the recorded run on the live site (Chrome on an 8-core machine), 402,191 rows were imported in 47.5 seconds with no main-thread task of 50 ms or more, and a cancel stopped processing in 53 ms. Device, method and every field are in [BENCHMARK.md](BENCHMARK.md) (`tests/e2e/benchmark.spec.ts`).
- **Five vendor formats and custom CSV are read correctly.** OpenAI, Anthropic, OpenRouter, LiteLLM and OpenTelemetry logs, plus any other CSV through a column mapping. Every supported variant below has a fixture with expected token classes (`tests/unit/adapters-*.test.ts`, `tests/unit/detect.test.ts`) and imports through the UI (`tests/e2e/fixtures.spec.ts`).
- **Every row is priced by token class.** Uncached input, cache reads, cache writes by duration and output are priced separately. Reasoning tokens are shown inside output and never added on top (`tests/unit/pricing.test.ts`, `tests/unit/properties.test.ts`).
- **Money is exact.** Rates keep their original decimal text and are converted to integer femto-dollars. Row costs and totals are integer sums. Rounding happens only for display.
- **No file content in network requests.** A test intercepts every request, allows only the app's own files and pricing snapshot, and searches them for a unique marker from each fixture. A deliberate cross-origin request is blocked by the content security policy (`tests/e2e/privacy.spec.ts`).
- **Savings are compared like with like.** The savings modeller reprices every stored row through the same row pricer and snapshot, per request, with its own write durations and tier. The same model with neutral assumptions gives exactly $0 savings, and logged charges are compared with list price on their own line, never as savings (`tests/unit/scenario.test.ts`, `tests/unit/properties.test.ts`, `tests/e2e/savings.spec.ts`).
- **Missing usage is never priced as zero.** When a row lacks input tokens, or output tokens for a call that bills output, it keeps a logged charge if it has one; otherwise it is Unresolved with the reason, and the total is marked partial (`tests/unit/absent-usage.test.ts`).
- **Exports.** Where the browser offers a save dialog, the row CSV streams from the worker into the chosen file. Elsewhere it is built from 8 MiB parts and downloaded; on the test machine that fallback completed every size tried, the largest a 4,122,448,689 byte export of 4,826,541 rows. Larger exports were not tried (`tests/e2e/export.spec.ts`).
- **Accessible.** Automated checks find no serious or critical issues, and a keyboard-only path from import to export works (`tests/e2e/a11y.spec.ts`).

## Supported variants

| Id | Source | Format | Fixture |
|---|---|---|---|
| A-json | OpenAI Chat Completions responses | JSON array | `fixtures/a-openai-chat.json` |
| A-jsonl | OpenAI Chat Completions responses | JSONL | `fixtures/a-openai-chat.jsonl` |
| B-json | OpenAI Responses API responses | JSON array | `fixtures/b-openai-responses.json` |
| B-jsonl | OpenAI Responses API responses | JSONL | `fixtures/b-openai-responses.jsonl` |
| C-page | OpenAI organization Usage API, completions buckets | JSON page as returned | `fixtures/c-openai-usage-page.json` |
| D-json | Anthropic Messages responses | JSON array | `fixtures/d-anthropic-messages.json` |
| D-jsonl | Anthropic Messages responses | JSONL | `fixtures/d-anthropic-messages.jsonl` |
| E-json | OpenRouter responses with usage accounting | JSON array | `fixtures/e-openrouter.json` |
| E-jsonl | OpenRouter responses with usage accounting | JSONL | `fixtures/e-openrouter.jsonl` |
| F-csv | LiteLLM spend logs | CSV | `fixtures/f-litellm-spend.csv` |
| F-json | LiteLLM spend logs | JSON array | `fixtures/f-litellm-spend.json` |
| G-otlp | OpenTelemetry GenAI spans | OTLP JSON | `fixtures/g-otel-spans.json` |
| G-otlp-jsonl | OpenTelemetry GenAI spans | OTLP JSON, one request per line | `fixtures/g-otel-spans.jsonl` |
| H-csv | Any other CSV, through a column mapping | CSV | `fixtures/h-custom.csv` |

Anything else shows "not supported yet". Edge cases have their own fixtures: byte-order mark, quoted newlines, missing columns, mixed models, malformed rows and multibyte text across a chunk boundary.

## Worked examples

Pinned to the stored snapshot `public/pricing/2026-10-29-aa992e3f.json` (its SHA-256 is recorded in `fixtures/worked-examples.json`):

| Call | Engine result |
|---|---|
| Chat Completions, prompt 2,006 with 1,920 cached, completion 300, `gpt-4o` | $0.005615 |
| Messages, input 2,048, cache read 1,800, cache write 148 at 5 minutes and 100 at 1 hour, output 503, `claude-sonnet-4-5-20250929` | $0.015384 |
| Responses, input 12,000 with 4,000 cached and 7,000 written (3,000 at 30 minutes, 4,000 at 12 hours), output 500, `gpt-6.1-sol` | $0.034900 |

The tests also assert the engine never produces $0.010415 (cached tokens added on top of input) or $0.048900 (cache writes not subtracted).

## Labels

Every value carries one label with a one-line reason: Measured, Measured charge, Estimated, Not measured, Not priced or Unresolved.

- A valid zero shows $0 with its source: an explicit zero rate in the snapshot, or a reported charge of 0.
- Not priced means the model or a needed rate is missing. The value stays empty, never $0.
- Unresolved means a gateway logged a spend of 0 while the snapshot rate is not zero, or the row's numbers contradict each other. It needs review.

A total that leaves out Not priced or Unresolved rows is marked as a partial total.

## Pricing snapshots

Prices come from `model_prices_and_context_window.json` in the BerriAI/litellm repository. `npm run pricing:refresh` resolves the latest commit of that file, fetches it from that exact commit, validates it and writes an immutable snapshot named by date and content hash to `public/pricing/`. `public/pricing/manifest.json` lists every snapshot with its date, upstream commit, SHA-256 and source URL. A scheduled workflow runs the refresh daily. If validation fails, nothing is written, the last good snapshot stays live and the job fails.

Each audit freezes the snapshot it used. Rows are labelled "current list price, snapshot DATE". Historical prices are not rebuilt.

## Run locally

```bash
npm ci
npm run dev
```

Checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

## Layout

- `src/engine`: parsing, normalization, pricing, aggregation, identity and export. No DOM or React imports.
- `src/worker`: the module worker and the IndexedDB row store.
- `src/ui`: the Import, Audit and Proof areas.
- `schemas`: JSON Schema exported from the zod contracts.
- `fixtures`: one fixture per variant, edge cases and zero cases, with expected outputs.

## What this demo does not establish

Fit to a specific company's exports is proven only when its sample logs run through it.

## License

MIT
