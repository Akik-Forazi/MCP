# Benchmark history (withdrawn)

Status: **historical only.** The custom benchmark CLI, harness, results and public
leaderboard claims were removed from the product on 2026-10-19. Nothing in this
document is a current performance, security or conformance claim. The repository
no longer publishes a benchmark index or methodology.

## Why the claims were withdrawn

- HEAD's README claimed "fastest, most secure" with **~0.3 s cold start / ~65 MB**.
  The uncommitted working-tree README had already changed that to **147 ms /
  57.6 MB**; neither wording is retained.
- The published competitor numbers measured the `npx` **launcher process tree**
  (npm/npx resolution plus the server), while the Fraziym number measured the
  server process directly. That is not a like-for-like comparison.
- The old raw artifact `docs/bench-2026-10-19.json` at HEAD recorded **187 ms /
  66.2 MB** for the built dist. The working-tree version recorded **147 ms /
  57.6 MB**. The published claim used the later, lower run with no stated
  selection rule.
- Warm direct-launch reruns on the same machine recorded **127-134 ms / ~69 MB
  process tree / ~61 MB root RSS** for this server. The 147 ms number was never
  reproduced under the same measurement conditions.
- `latest` on npm (`0.1.0-beta.1`) has **no `bin` entry**, so the advertised
  `npx -y @fraziym/mcp serve` quick start cannot work from `latest`; `beta`
  (`0.1.1-beta.0`) has `dist/cli/index.js` as `fraziym-mcp`.
- The untracked `docs/launch-copy.md` tagline sheet repeated the 147 ms/57.6 MB
  claim and was removed with the rest of the benchmark material; its numbers are
  covered by the caveats above.

## Environment (measured)

- Machine: HP ZBook, Intel Core i5-8265U (4C/8T, 1.6-1.8 GHz), 16 GB RAM,
  Windows 11 Pro 10.0.26200.
- Node v24.21.0, npm 11.19.0, Python 3.11.9, uvx 0.13.1, git 2.55.0.windows.3.
- Windows power plan: High performance (`8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c`).
- Warm caches (`C:\Users\user\AppData\Local\npm-cache`,
  `C:\Users\user\AppData\Local\uv\cache`); repo HEAD `5915d42`.
- Raw environment: [pilot-direct-2-environment.json](./evidence/pilot-direct-2-environment.json).

## What was measured

Warm stdio spawn -> `initialize` -> `tools/list`, 1 warmup + 2 measured runs,
plus full descendant-process-tree RSS, root-process RSS, tool count and a small
call set. `treeRss` is the whole process tree; `appRss` is the server process.

Direct-launch pilot (`pilot-direct-2`, raw:
[pilot-direct-2-summary.json](./evidence/pilot-direct-2-summary.json),
[pilot-direct-2-summary.txt](./evidence/pilot-direct-2-summary.txt)):

| Target | ok/n | init (median) | tools/list | tree RSS | root RSS | tools |
| --- | --- | --- | --- | --- | --- | --- |
| `@fraziym/mcp` self-published `0.1.1-beta.0` | 2/2 | 127.2 ms | 1 ms | 69.2 MB | 61.1 MB | 74 |
| `@fraziym/mcp` built dist | 2/2 | 134.0 ms | 1 ms | 69.9 MB | 61.7 MB | 74 |
| `server-everything@2.0.0` | 2/2 | 307.2 ms | 10.4 ms | 85.7 MB | 77.6 MB | 16 |
| `server-filesystem@2.0.0` | 2/2 | 288.3 ms | 12.0 ms | 83.7 MB | 75.6 MB | 14 |
| `server-memory@2.0.0` | 2/2 | 245.5 ms | 8.0 ms | 80.8 MB | 72.7 MB | 9 |

Call smoke: `file-read`, `file-list`, `git-status`, `get-time` returned 10/10 ok
per target in the Fraziym rows; `server-everything` `echo` 10/10. Validation
checks: 50/50 passed ([pilot-direct-2-validation.json](./evidence/pilot-direct-2-validation.json)).

A first pilot (`pilot-direct-1`) recorded 202.2 ms self-published / 240.3 ms
self-dist / ~69 MB before the cache and harness were warmed; see
[pilot-direct-1-summary.txt](./evidence/pilot-direct-1-summary.txt). Treat both
pilots as directional, not release quality.

## Cold install

`@fraziym/mcp@0.1.1-beta.0` in an empty npm prefix
([pilot-direct-1-prepare.json](./evidence/pilot-direct-1-prepare.json)):

| Package | Install | Size | Files |
| --- | --- | --- | --- |
| `@fraziym/mcp@0.1.1-beta.0` | 140.9 s | 1,305.6 MB | 18,115 |
| `@modelcontextprotocol/server-everything@2.0.0` | 18.0 s | 21.7 MB | 2,510 |
| `@modelcontextprotocol/server-filesystem@2.0.0` | 9.8 s | 20.1 MB | 1,380 |
| `@modelcontextprotocol/server-memory@2.0.0` | 6.6 s | 13.4 MB | 956 |

The Fraziym install pulls `@fraziym/axoniz`, its non-optional peer
`@fraziym/axodex`, `node-llama-cpp`, tree-sitter/native packages and
`@ladybugdb/core`. This is the main installation-cost problem to solve in the
standalone migration; the cache is intentionally not preserved.

## npx / stack smoke (directional only)

An earlier artifact measured `npx` competitors at 2.75-3.07 s and 167.8-186.1 MB
versus the 147 ms / 57.6 MB server-only claim; the comparison is invalid because
the denominators differ. A five-server stack smoke recorded 5/5 running servers,
45 tools, 688 MB tree RSS and 647.6 MB app RSS
([stack-smoke-2-summary.json](./evidence/stack-smoke-2-summary.json)); it was
polluted by cold `uvx`/`npx` starts (max ready 6,739.8 ms) and is not a result.

## Installation failures observed

- GitHub (legacy npm) prepare reused a polluted prefix in the first stack smoke;
  a later `prepare.ts` run failed with `npm error code EALLOWSCRIPTS` /
  `npm error --allow-scripts is not allowed in project-scoped installs`.
- A manual install with an empty `--userconfig` succeeded (46 packages, 14 s),
  but the harness path still failed. The harness was removed rather than
  carrying this local npm configuration issue into the product.
- Do not repeat the npm auth token from the machine `~/.npmrc` in logs or docs.

## Evidence files

- [pilot-direct-1-prepare.json](./evidence/pilot-direct-1-prepare.json) — cold installs.
- [pilot-direct-1-summary.txt](./evidence/pilot-direct-1-summary.txt) — colder pilot.
- [pilot-direct-2-summary.json](./evidence/pilot-direct-2-summary.json) — per-metric medians, calls, hashes.
- [pilot-direct-2-summary.txt](./evidence/pilot-direct-2-summary.txt) — human summary.
- [pilot-direct-2-validation.json](./evidence/pilot-direct-2-validation.json) — 50/50 checks.
- [pilot-direct-2-environment.json](./evidence/pilot-direct-2-environment.json) — machine/versions.
- [stack-smoke-2-summary.json](./evidence/stack-smoke-2-summary.json) — five-server smoke, not a result.
- [clean-install-2026-10-19.md](./evidence/clean-install-2026-10-19.md) — post-cleanup isolated install/launch check, not a benchmark.

## What remains verifiable today

`npm run prove` (tool reachability), `npm run fuzz` (workspace jail), `npm test`
(unit/integration) and the official MCP conformance artifact
(`docs/conformance-2026-10-19.md`) remain. They do not feed a scoreboard and
must not be used as performance or security marketing.
