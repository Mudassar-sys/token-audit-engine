# Benchmark

One recorded run of the 200 MB benchmark against the live site, plus the CI runs behind the responsiveness budget. Nothing here goes beyond what these runs measured.

## How it runs

The Proof area's Benchmark page (and `tests/e2e/benchmark.spec.ts`) does this in the browser:

1. Generates a synthetic LiteLLM spend log CSV of exactly 209,715,200 bytes in a worker from a seed. The generator reports its row count, the file's SHA-256, and how many rows it wrote to be Not priced (unknown models) and Unresolved (spend 0 on a priced model).
2. Imports it and cancels when half of the bytes are read, then checks that the store holds no rows from that import.
3. Imports it again to completion.
4. Runs a routing scenario over every stored row (all models to `gpt-4o-mini`, eligible share 0.5).
5. Exports the row CSV through the streaming path into an origin private file (a save dialog cannot run unattended), reads it back and counts its records.

Long tasks are counted on the main thread with a `longtask` performance observer during the full import. Interactions are measured with Event Timing (`event` entries, threshold 16 ms): the time from a real key press or click to the next rendered frame. The test presses Tab and clicks the page heading while the import runs. Peak memory is the largest value from `performance.measureUserAgentSpecificMemory()` sampled during the run (page and worker). The true peak can be higher than a sampled value.

The run uses an on-disk browser profile, as a visitor's browser does.

## Recorded run

| Field | Value |
|---|---|
| Date | 2026-10-29 16:58 UTC |
| Site | https://token-audit-engine.vercel.app |
| Browser | Google Chrome 156.0.8078.73, Windows 10, 64-bit, on-disk browser profile |
| CPU cores | 8 |
| Memory class | 16 GB (`navigator.deviceMemory`) |
| Seed | 20261029 |
| File SHA-256 | `1cfc91ee02d5a15353c1477721e505cdf9165507177eaa2d4f124a41b31e862b` |
| File size | 209,715,200 bytes |
| Rows written | 402,191 |
| Columns | 29 |
| Source mix (rows by provider) | openai 221,119, anthropic 108,692, gemini 36,224, codestral 32,110, hosted_vllm 4,046 |
| Pricing snapshot | `2026-10-29-d15094df.json`, SHA-256 `d15094dfb82e25fed51ffe7a9fb935f1058cff7851c8f5a9af62cb1a4903bb4c` |
| Rows imported | 402,191 |
| Not priced (expected by design) | 8,026 (8,026) |
| Unresolved (expected by design) | 3,663 (3,663) |
| Total import time | 31.0 seconds |
| Rows per second | 12,986 |
| Peak memory during the import (sampled) | 77,030,671 bytes |
| Cancel response time (cancel request until processing stopped) | 20 ms |
| Partial rows deleted after the cancel in | 32 ms |
| Rows left in the store after the cancel | 0 |
| Long tasks of 50 ms or more during the import | 0 (longest 0 ms) |
| Interactions during the import | 9, longest 32 ms from input to next frame |
| Routing scenario over all rows | 23.9 seconds, 402,191 rows |
| CSV export | streaming path, 343,112,636 bytes in 13.8 seconds |
| Peak memory during the export (sampled) | 44,058,462 bytes |
| Rows in the exported CSV, parsed back | 402,191 |

The raw record is in `public/benchmarks/results.json` and is shown on the site's Benchmark page.

## Responsiveness budget

The end-to-end test fails if, during the full import, the longest main-thread task or the longest interaction (input to next frame) passes 200 ms. 200 ms is the published good threshold for interaction to next paint; a main-thread task longer than that would hold an interaction past it. Shared CI runners are slower than desktops, so the budget is this user-facing threshold rather than the 50 ms long-task line. Zero long tasks is a recorded result, not an acceptance rule.

The budget was set before these runs and checked with three CI runs of the same commit:

| CI run | CPU cores | Import time | Longest task | Interactions | Longest interaction |
|---|---|---|---|---|---|
| 1 | 4 | 24.4 s | 0 ms | 9 | 24 ms |
| 2 | 4 | 23.7 s | 0 ms | 9 | 24 ms |
| 3 | 4 | 29.5 s | 0 ms | 10 | 24 ms |

## CSV export fallback

Where the browser has no save dialog, the worker builds the CSV from 8 MiB parts and the page downloads it. On the machine above it completed every size tried, imported and exported in Chrome with an on-disk profile:

| Input | Rows | Export size | Export time |
|---|---|---|---|
| 200 MiB | 402,280 | 343,092,207 bytes | 12.6 s |
| 400 MiB | 804,503 | 686,338,426 bytes | 27.3 s |
| 800 MiB | 1,608,854 | 1,373,438,224 bytes | 69.2 s |
| 1,600 MiB | 3,217,695 | 2,747,898,351 bytes | 130.6 s |
| 2,400 MiB | 4,826,541 | 4,122,448,689 bytes | 250.9 s |

Larger exports were not tried. The browser keeps a large Blob on disk once it passes its in-memory limit, so the point where the fallback fails depends on the device's memory and free disk; no general bound is claimed.

## Limits

This is one recorded run on one machine and one browser. Other devices, browsers and files will give other numbers.
