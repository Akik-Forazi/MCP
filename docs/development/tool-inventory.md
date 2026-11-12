# Tool inventory (74 catalog tools)

Source of truth: `catalog.json` (74 default group tools), cross-checked against
`src/` registration and `prove-report.json` (run 2026-10-19 in a throwaway
workspace). A tool being present in the catalog does **not** mean it works in
every environment; the `Prove` column is the dispatch evidence.

Column legend:

- **Kind**: `local` = implementation lives in this repo; `axoniz` = repo wrapper
  loads `@fraziym/axoniz` at call time; `axodex` = calls the `axodex` CLI
  (`@fraziym/axodex` / PATH / `npx` fallback); `stub` = advertised but always
  returns an explicit error.
- **Prove**: `ok` = dispatched successfully; `env-error` = environment missing
  (not code unreachable); `desktop-skipped` = no interactive session;
  `stub` = intentional unsupported error.
- **Tests** (existing automated evidence only): `A` `test/axoniz.test.ts`,
  `C` `test/catalog.test.ts`, `G` `test/guard.test.ts`, `T`
  `test/toolbox.test.ts`, `GW` `test/gateway.test.ts`.
- **Status**: migration status. Every tool starts `not started` until an
  implementation is ported, adapter-backed, or explicitly deprecated.

## Files (9) — `src/tools/files.ts` (via `@fraziym/axoniz/tools` `FileTools`)

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `file_read` | axoniz | workspace filesystem | ok | A, C, G, T, GW | not started |
| `file_write` | axoniz | writable workspace | ok | A, C, T | not started |
| `file_edit` | axoniz | writable workspace | ok | A, T | not started |
| `file_append` | axoniz | writable workspace | ok | A | not started |
| `file_delete` | axoniz | writable workspace | ok | A | not started |
| `file_list` | axoniz | workspace filesystem | ok | A | not started |
| `file_search` | axoniz | workspace filesystem | ok | A, T | not started |
| `file_patch` | axoniz | workspace + existing target file | env-error (`prove.txt` missing) | C, T | not started |
| `file_grep` | axoniz | workspace filesystem | ok | C, T | not started |

`file_patch`/`file_grep` are the mcp-only extras (not registered by
`axonizTools({ extras: false })`, registered by `xorvoidTools`/default).

## Shell (2) — `src/tools/shell.ts` (via `ShellTools`)

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `shell_run` | axoniz | OS shell; arbitrary command execution | ok | A, T | not started |
| `shell_python` | axoniz | OS shell + `python` on PATH | ok | A | not started |

## Web (2) — `src/tools/web.ts` (via `WebTools`)

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `web_search` | axoniz | network | ok | A, T | not started |
| `web_get` | axoniz | network | ok | A, C, T | not started |

## Code (4) — `src/tools/code.ts` (via `CodeTools`)

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `code_tree` | axoniz | workspace filesystem | ok | A | not started |
| `code_analyze` | axoniz | Python source tree | ok | A | not started |
| `code_lint` | axoniz | Python + flake8 | ok | A | not started |
| `code_format` | axoniz | Python + black | ok | A | not started |

## Git (10) — `src/tools/git.ts` (local wrapper around the `git` CLI)

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `git_status` | local | `git` + repo | ok | A, C, GW, T | not started |
| `git_diff` | local | `git` + repo | ok | A, T | not started |
| `git_log` | local | `git` + repo with commits | env-error (prove repo has no commits) | A, T | not started |
| `git_add` | local | `git` + repo | ok | A, C, G | not started |
| `git_commit` | local | `git` + repo + identity | ok | A, G | not started |
| `git_branch` | local | `git` + repo | ok | A | not started |
| `git_checkout` | local | `git` + repo + pathspec | env-error (prove pathspec) | A, G | not started |
| `git_push` | local | `git` + repo + remote + credentials | env-error (no remote) | A, G | not started |
| `git_pull` | local | `git` + repo + upstream + credentials | env-error (no tracking) | A | not started |
| `git_stash` | local | `git` + repo | ok | A | not started |

## Axodex (7) — `src/tools/axodex.ts`

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `axodex_query` | axodex | `axodex` CLI + index | ok | A, T | not started |
| `axodex_context` | axodex | `axodex` CLI + index | ok | A | not started |
| `axodex_impact` | axodex | `axodex` CLI + index | ok | A, T | not started |
| `axodex_smart_read` | axodex | `axodex` CLI + index | ok | A | not started |
| `axodex_status` | axodex | `axodex` CLI | ok | A | not started |
| `axodex_detect_changes` | axodex | `axodex` CLI + index | ok | A | not started |
| `axodex_analyze` | axodex | `axodex` CLI + full index (slow) | env-error (20 s timeout) | A | not started |

The CLI is located via `@fraziym/axodex` resolution, PATH, or
`npx --no-install @fraziym/axodex`. Axodex is currently a non-optional peer of
Axoniz, so it is installed with this package even when unused.

## Computer (7) — `src/tools/computer.ts` (via `ComputerTools`)

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `mouse_move` | axoniz | interactive desktop session | desktop-skipped | A | not started |
| `mouse_click` | axoniz | interactive desktop session | desktop-skipped | A | not started |
| `key_type` | axoniz | interactive desktop session (type path exercised) | ok | A | not started |
| `key_press` | axoniz | interactive desktop session | desktop-skipped | A | not started |
| `screen_size` | axoniz | desktop/display access | desktop-skipped | A | not started |
| `screen_capture` | axoniz | desktop + screen capture permissions | desktop-skipped | A | not started |
| `screen_find` | axoniz | desktop + screen capture permissions | desktop-skipped | A | not started |

Optional native/desktop packages (`screenshot-desktop`, `sharp`) are installed
by Axoniz as optional dependencies; the tools must stay lazy.

## Memory (20) — `src/tools/memory.ts` (via `@fraziym/axoniz/memory` `UnifiedMemory`)

KV (3):

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `memory_save` | axoniz | writable memory store | ok | A | not started |
| `memory_get` | axoniz | memory store | ok | A | not started |
| `memory_list` | axoniz | memory store | ok | A | not started |

Palace (10):

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `palace_search` | axoniz | memory store + index | ok | A | not started |
| `palace_store` | axoniz | writable memory store | ok | A | not started |
| `palace_context` | axoniz | memory store | ok | A | not started |
| `palace_wings` | axoniz | memory store | ok | A | not started |
| `palace_rooms` | axoniz | memory store | ok | A | not started |
| `palace_check_dup` | axoniz | memory store | ok | A | not started |
| `palace_delete` | axoniz | writable memory store | ok | A | not started |
| `palace_graph_traverse` | axoniz | memory graph store | ok | A | not started |
| `palace_find_tunnels` | axoniz | memory graph store | ok | A | not started |
| `palace_graph_stats` | axoniz | memory graph store | ok | A | not started |

Knowledge graph (5):

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `kg_add` | axoniz | writable KG store | ok | A | not started |
| `kg_query` | axoniz | KG store | ok | A | not started |
| `kg_invalidate` | axoniz | writable KG store | ok | A | not started |
| `kg_timeline` | axoniz | KG store | ok | A | not started |
| `kg_stats` | axoniz | KG store | ok | A | not started |

Diary (2):

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `diary_write` | axoniz | writable memory store | ok | A | not started |
| `diary_read` | axoniz | memory store | ok | A | not started |

Memory paths default to Axoniz's own storage location and can be overridden via
`memoryPaths` (`palace_path`, `kg_path`).

## Misc (3) — `src/tools/misc.ts`

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `get_time` | local | none | ok | A, C | not started |
| `done` | local | none | ok | A, GW, G | not started |
| `absolute_query` | axoniz + axodex | memory store + axodex index | ok | A | not started |

## Agent-runtime stubs (10) — `src/tools/stubs.ts`

| Tool | Kind | Needs | Prove | Tests | Status |
| --- | --- | --- | --- | --- | --- |
| `swarm_spawn` | stub | Axoniz agent runtime (not exported standalone) | stub | A | not started |
| `shadow_step` | stub | Axoniz agent runtime | stub | A | not started |
| `war_room` | stub | Axoniz agent runtime | stub | A | not started |
| `goal_create` | stub | Axoniz agent runtime | stub | A | not started |
| `goal_list` | stub | Axoniz agent runtime | stub | A, C | not started |
| `goal_kr_add` | stub | Axoniz agent runtime | stub | A | not started |
| `goal_action_add` | stub | Axoniz agent runtime | stub | A | not started |
| `goal_update_score` | stub | Axoniz agent runtime | stub | A | not started |
| `goal_action_complete` | stub | Axoniz agent runtime | stub | A | not started |
| `goal_report` | stub | Axoniz agent runtime | stub | A | not started |

Each returns `[ERROR] <tool>: requires the axoniz agent runtime`. They are
currently advertised to keep the 74-tool surface stable; the standalone plan
must either implement them, keep them explicitly marked unsupported, or remove
them with a documented deprecation (no silent reduction).

## Totals

- 74 advertised by default; 87 with `--router-tools` (74 + 13 gateway endpoints).
- By kind: local 12 (git 10 + `get_time`/`done`), axoniz-backed 44 (files 9,
  shell 2, web 2, code 4, computer 7, memory 20), axodex 7, hybrid
  axoniz+axodex 1 (`absolute_query`), stubs 10.
- Prove: 52 `ok`, 10 `stub`, 6 `env-error`, 6 `desktop-skipped`, 0 unreachable.
