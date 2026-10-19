# @fraziym/mcp

[![ci](https://github.com/Akik-Forazi/MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Akik-Forazi/MCP/actions/workflows/ci.yml)
[![codeql](https://github.com/Akik-Forazi/MCP/actions/workflows/codeql.yml/badge.svg)](https://github.com/Akik-Forazi/MCP/actions/workflows/codeql.yml)
[![npm](https://img.shields.io/npm/v/@fraziym/mcp?label=npm)](https://www.npmjs.com/package/@fraziym/mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](https://nodejs.org)

**The fastest, most secure MCP toolbelt server.** 74 tools (files · shell · web · code · git · axodex · memory) behind one process that cold-starts in ~0.3 s and idles at ~65 MB — with a second, smaller MCP surface on top: the `router/*`, `fix/*` and `brain/*` gateway endpoints.

Ships dual-era MCP: **protocol 2026-07-28** (stateless, per-request `_meta`, `server/discover`) **plus legacy** initialize-based clients (Claude Desktop, Cursor, Zed, …) over stdio or Streamable HTTP. Every claim below is reproducible — the harnesses and raw artifacts live in this repo (`bench` · `prove` · `fuzz`, `test/`, `catalog.json`).

## Verified performance

One line to run it:

```sh
npx -y @fraziym/mcp serve   # stdio MCP server, 74 tools (+ --router-tools for the gateway)
```

`npm run bench:competitors` (medians of 3 runs, warm `npx` cache, Windows 11, Node 24 — 2026-10-19; raw artifact: [`docs/bench-2026-10-19.json`](./docs/bench-2026-10-19.json)):

| Server | Ready (spawn→initialize) | tools/list | Tools | RSS |
| --- | --- | --- | --- | --- |
| **@fraziym/mcp (built dist)** | **187 ms** | **1 ms** | **74** | **66.2 MB** |
| @fraziym/mcp (`bin/fraziym-mcp.exe`) | 327 ms | 2 ms | 74 | 66.2 MB |
| @fraziym/mcp (source, type-stripped) | 390 ms | 1 ms | 74 | 76.6 MB |
| @modelcontextprotocol/server-sequential-thinking | 4.81 s | 9 ms | 1 | 177.4 MB |
| @modelcontextprotocol/server-everything | 4.02 s | 8 ms | 12 | 178.4 MB |
| @modelcontextprotocol/server-filesystem | 3.83 s | 12 ms | 14 | 197.4 MB |
| @modelcontextprotocol/server-memory | 3.57 s | 9 ms | 9 | 178.6 MB |

Cold `tools/list` is answered from a build-time catalog (`catalog.json`) — no provider SDK or tool class is imported until its family is first called. Self-startup varies 187–299 ms across runs on this machine; npx competitors are 2–3× slower on a cold cache. Run it yourself: `npm run bench -- --competitors --json`.

Cross-checked against an independent dataset (TechFuelHQ, Windows 11, 2026-08-19, warm caches, 11 popular servers): the same server family measures 0.55–1.9 s ready and 178–422 MB RSS there — so on both methodologies `@fraziym/mcp` is the fastest and lightest general-purpose MCP server measured to date, with 74 tools in a single process where the benchmarked field needs 5–8 servers (~962 MB for a five-server stack) to cover less.

## Verified correctness & security

| Evidence | Result | Reproduce |
| --- | --- | --- |
| YawLabs MCP Compliance (2026-07-28 suite) | **Score 99 · Grade A** — 28/28 required checks pass; 2 optional fails documented below | `npx -y @yawlabs/mcp-compliance test http://127.0.0.1:7777/mcp --auth "Bearer SECRET"` |
| Own test suite | 91 tests, 90 pass / 1 skip (live-server test) | `npm test` |
| `prove` — every catalog tool dispatched once in a throwaway workspace | 74 tools: 52 ok · 10 agent-runtime stubs · 6 env-errors (fresh repo / no remote) · 6 desktop-skipped · **0 unreachable** | `npm run prove` → `prove-report.json` |
| `fuzz` — adversarial path pack vs the workspace jail | 327 cases (27 known CVE-shaped + 300 seeded), **0 escapes**; oversized args rejected by both caps | `npm run fuzz` → `fuzz-report.json` |

YawLabs residual (both are environment/design, not protocol defects, and reported by the suite as optional):

- `security-tls-required` — fails only when serving plain `http://` on loopback for local tests; put TLS in front (reverse proxy/tunnel) for remote use.
- `security-oauth-metadata` — the check wants a **non-empty** `authorization_servers` array. We do publish RFC 9728 Protected Resource Metadata at `/.well-known/oauth-protected-resource` (with `WWW-Authenticate: Bearer resource_metadata="…"` on 401) but run **static bearer tokens, not OAuth**: advertising an authorization server we don't have would be dishonest, so `authorization_servers` is `[]`.

Official MCP conformance suite (server suite ships for 2025-11-25; 30 scenarios): **8 passed / 22 failed, zero regressions**, where the pass set covers everything this server implements — `initialize`, `ping`, `logging/setLevel`, `tools/list`, `tools/call` (text + error), and both DNS-rebinding checks. The remaining scenarios exercise resources, prompts, completions, sampling, elicitation, progress/content/logging *fixture* tools and SSE stream fixtures — features a stateless 2026-07-28 toolbelt server intentionally does not expose (sampling/elicitation were replaced by MRTR in that revision). No fake `test_*` fixtures were added to game the suite.

Security engineering (details in [SECURITY.md](./SECURITY.md)): workspace jail with realpath containment, path-arg caps published as `maxLength: 4096` in every schema and enforced before dispatch (`-32602`), 2 MiB argument cap, output truncation, secret-redacted audit log, and the 2026 header/identity checks (`-32020` mismatches, `-32022` version). HTTP mode binds `127.0.0.1` by default, validates `Origin` (DNS-rebinding), disables sessions, is POST-only, supports `--token` bearer auth, and rate-limits `tools/call` per client (burst 30, 15/s; `--rate-limit N|off`). This closes the known 2025–2026 MCP CVE classes by construction: filesystem traversal (CVE-2025-53109/53110), git args as flags/options injection (CVE-2025-68143/44/45), unvalidated redirect/OAuth in proxies (CVE-2025-6514), and 0.0.0.0 dashboard exposure à la Grafana MCP.

## Groups

| Group | Tools | Composition |
| --- | --- | --- |
| `xorvoidTools` | 25 | files 9 (incl. `file_patch`/`file_grep` extras), shell 2, web 2, git 3 (read-only), code 4, axodex 5 |
| `axonizTools` | 72 | the complete axoniz tool surface (below) |
| `all` (default) + `--router-tools` | 87 | 74 catalog tools + 13 gateway endpoints (`router_*`, `fix_*`, `brain_*`, `tools_discover`, `audit_tail`) |

`axonizTools` breakdown (72): files 7 · shell 2 · web 2 · code 4 · git 10 (full, incl. push/pull/stash) · axodex 7 · computer 7 · memory 20 (`UnifiedMemory`: KV + palace + KG + diary) · misc 3 (`get_time`, `done`, `absolute_query`) · agent-runtime 10 (`swarm_spawn`, `shadow_step`, `war_room`, `goal_*`) — these last ten return explicit `[ERROR] … requires the axoniz agent runtime` strings until axoniz exports goals/swarm standalone. Read-only tools publish MCP `annotations` (`readOnlyHint`/`destructiveHint`/`openWorldHint`) and `tools/list` stays catalog-static: the default server always advertises exactly **74**.

## Gateway endpoints (`serve --router-tools`)

Custom endpoints for agent orchestration, configured via **`~/.fraziym/config.json` — the shared Fraziym ecosystem config** (override `$FRAZIYM_HOME`; put the keys at the top level or under an `"mcp"` section so other Fraziym products can share the file). API keys come from `apiKeyEnv` (recommended) or inline `apiKey` and are never echoed — `router_status` reports presence, not material. Audit log and fix queue stay per-product in the machine-local FRAZIYM cache — `%LOCALAPPDATA%\FRAZIYM\mcp` on Windows, `~/.cache/fraziym/mcp` on Linux (`$FRAZIYM_MCP_HOME`).

```json
{
  "providers": [
    { "name": "openrouter", "kind": "openai", "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY", "models": ["anthropic/claude-sonnet-4-5"] },
    { "name": "local", "kind": "openai", "baseUrl": "http://127.0.0.1:11434/v1", "models": ["qwen3"] }
  ],
  "routing": { "default": "openrouter", "byModelPrefix": { "gpt": "openrouter" } },
  "verify": [ { "name": "test", "cmd": "npm", "args": ["test"] } ]
}
```

| Endpoint | What it does |
| --- | --- |
| `router_ask` | Chat completion through the provider pool with automatic failover (retryable = network/408/409/425/429/5xx) |
| `router_race` | Races the same prompt across several models, returns the first success |
| `router_delegate` | Route a task to one specific model (exact provider model lists → prefix routing → default pool) |
| `router_status` | Providers, key presence (never key material), routing rules, verify commands |
| `fix_verify` | Runs the configured verify commands (test/lint/…) in the workspace, pass/fail + output tails |
| `fix_shadow` | Applies candidate `{path, content}` files in a **throwaway git worktree**, runs `test_cmd` there, reports — the workspace is never touched |
| `fix_queue_pull` / `fix_queue_complete` | Append-only fix queue in the machine-local FRAZIYM cache (`%LOCALAPPDATA%\FRAZIYM\mcp\fix-queue.jsonl`) |
| `brain_absolute` | Combined code-graph (axodex) + long-term memory (palace) search |
| `brain_pack` | Context pack for a task: workspace overview + axodex matches + palace matches, token-budgeted |
| `brain_remember` | Durable palace note (`memory_save` with brain-prefixed keys) |
| `tools_discover` | Rank the catalog by keyword so an agent finds the right tool without loading 74 schemas |
| `audit_tail` | Tail the redacted audit log (filterable by tool) |

## Usage

```ts
import { xorvoidTools } from "@fraziym/mcp/xorvoid";
import { axonizTools } from "@fraziym/mcp/axoniz";

const tools = axonizTools({ workspace: process.cwd() });
// optional memory isolation (defaults to axoniz's own home paths):
// axonizTools({ workspace, memoryPaths: { palace_path: "...", kg_path: "..." } })

tools.specs();                                            // OpenAI function schemas
await tools.call("file_read", { path: "src/index.ts" });  // string result
tools.has("git_push");                                    // true in axonizTools, false in xorvoidTools
tools.meta("git_push");                                   // { destructive: true, network: true }
```

## CLI

Ships with the package as `fraziym-mcp`. On Windows the tarball also includes `bin/fraziym-mcp.exe` — a tiny launcher that runs the CLI through your installed Node, so MCP clients spawn a real exe instead of a `.cmd` shim:

```sh
fraziym-mcp serve [--group axoniz|xorvoid|all] [--workspace .] [--read-only] [--no-network]
                  [--allow-outside] [--no-audit] [--http] [--port 7777] [--host 127.0.0.1]
                  [--token SECRET] [--rate-limit 30|off] [--router-tools]
fraziym-mcp tools [--group ...] [--json]
fraziym-mcp call <tool> '{"arg":"value"}'
fraziym-mcp bench [--runs 3] [--competitors] [--json]
fraziym-mcp prove [--out prove-report.json] [--include-input]
fraziym-mcp fuzz [--cases 300] [--seed 1337] [--out fuzz-report.json]
fraziym-mcp doctor
fraziym-mcp install claude|cursor [--write]
fraziym-mcp version
```

`serve` speaks MCP (JSON-RPC 2.0) over stdio by default — point Claude Desktop / Cursor / Zed at it (`fraziym-mcp install claude` prints the ready config). Default group is `all` (axoniz 72 + the xorvoid extras); `--read-only` strips destructive tools and `--no-network` strips network tools. Axoniz's logger writes to stderr, so stdout stays pure protocol.

## Contract

- `specs()` → OpenAI/OpenRouter `tools` array (function schemas), directly passable to chat-completions.
- `call(name, args)` → `Promise<string>`; **never throws** — failures come back as `[ERROR] <tool>: <message>` strings so an agent loop keeps going.
- `meta(name)` → `{ readOnly?, destructive?, network? }` capability flags for role-scoped allowlists; served as MCP annotations.
- File/shell/git/axodex/computer handlers are scoped to `workspace` (jail enforced by our guard: realpath containment, arg caps); axoniz `file_*` tools are registered without the mcp-only `patch`/`grep` extras.
- Requires Node >= 24.

## Install

```sh
npm install @fraziym/mcp
```

## License

MIT © AKIK FARAJI
