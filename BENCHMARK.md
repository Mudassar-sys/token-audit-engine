# Benchmark

One recorded run of the 200 MB benchmark against the live site. Nothing here goes beyond what this run measured.

## How it runs

The Proof area's Benchmark page (and `tests/e2e/benchmark.spec.ts`) does this in the browser:

1. Generates a synthetic LiteLLM spend log CSV of exactly 209,715,200 bytes in a worker. It mixes providers and models, cached and reasoning tokens, unknown models and zero spend rows.
2. Imports it and cancels when half of the bytes are read.
3. Imports it again to completion.

Long tasks are counted on the main thread with a `longtask` performance observer during the full import. Peak memory is the largest value from `performance.measureUserAgentSpecificMemory()` sampled during the run (page and worker). It needs a cross-origin isolated page, which the site is. The true peak can be higher than a sampled value.

The run uses an on-disk browser profile, as a visitor's browser does. A throwaway automation profile keeps IndexedDB in memory and can hit its storage limit on a file this size; the app then stops with a clear message and deletes the partial rows.

## Recorded run

| Field | Value |
|---|---|
| Date | 2026-10-29 14:51 UTC |
| Site | https://token-audit-engine.vercel.app |
| Browser | Google Chrome 156.0.8078.73, Windows 10, 64-bit, on-disk browser profile |
| CPU cores | 8 |
| Memory class | 16 GB (`navigator.deviceMemory`) |
| File size | 209,715,200 bytes |
| Rows | 402,191 |
| Columns | 29 |
| Source mix (rows by provider) | openai 221,119, anthropic 108,692, gemini 36,224, codestral 32,110, hosted_vllm 4,046 |
| Total import time | 47.5 seconds |
| Rows per second | 8,469 |
| Peak memory (sampled) | 77,045,316 bytes |
| Cancel response time (cancel request until processing stopped) | 53 ms |
| Partial rows deleted after the cancel in | 51 ms |
| Cancel call until confirmation, deletion included | 309 ms |
| Long tasks of 50 ms or more during the import | 0 |

The raw record is in `public/benchmarks/results.json` and is shown on the site's Benchmark page.

## Limits

This is one run on one machine and one browser. Other devices, browsers and files will give other numbers.
