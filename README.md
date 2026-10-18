# @fraziym/mcp

Fraziym MCP — the axo ecosystem's shared agent toolbelt. Hardcoded, importable tool **groups** that wrap [`@fraziym/axoniz`](https://www.npmjs.com/package/@fraziym/axoniz) tool classes into OpenAI/OpenRouter-compatible function schemas — built for the hidden fixer agents (OrcaRouter / OpenRouter free models) and usable by any axo agent runtime.

## Groups

| Group | Tools | Composition |
| --- | --- | --- |
| `xorvoidTools` | 25 | files 9 (incl. `file_patch`/`file_grep` extras), shell 2, web 2, git 3 (read-only), code 4, axodex 5 |
| `axonizTools` | 72 | the complete axoniz tool surface (below) |

`axonizTools` breakdown (72): files 7 · shell 2 · web 2 · code 4 · git 10 (full, incl. push/pull/stash) · axodex 7 (incl. `axodex_detect_changes`/`axodex_analyze`) · computer 7 (mouse/keyboard/screen) · memory 20 (`UnifiedMemory`: plain KV + palace + knowledge graph + diary) · misc 3 (`get_time`, `done`, `absolute_query`) · agent-runtime 10 (`swarm_spawn`, `shadow_step`, `war_room`, `goal_*`) — these last ten return explicit `[ERROR] … requires the axoniz agent runtime` strings until axoniz exports goals/swarm standalone.

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
fraziym-mcp tools [--group ...] [--json]
fraziym-mcp call <tool> '{"arg":"value"}'
fraziym-mcp doctor
fraziym-mcp install claude|cursor [--write]
fraziym-mcp version
```

`serve` speaks MCP (JSON-RPC 2.0) over stdio — point Claude Desktop / Cursor / Zed at it (`fraziym-mcp install claude` prints the ready config). Default group is `all` (axoniz 72 + the xorvoid extras); `--read-only` strips destructive tools and `--no-network` strips network tools. Axoniz's logger writes to stderr, so stdout stays pure protocol.

## Contract

- `specs()` → OpenAI/OpenRouter `tools` array (function schemas), directly passable to chat-completions.
- `call(name, args)` → `Promise<string>`; **never throws** — failures come back as `[ERROR] <tool>: <message>` strings so an agent loop keeps going.
- `meta(name)` → `{ destructive?, network? }` capability flags for role-scoped allowlists.
- File/shell/git/axodex/computer handlers are scoped to `workspace` (axoniz enforces path-escape protection); axoniz `file_*` tools are registered without the mcp-only `patch`/`grep` extras.
- Requires Node >= 24.

## Install

```sh
npm install @fraziym/mcp
```

## License

MIT © AKIK FARAJI
