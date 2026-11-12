# Changelog

All notable changes to `@fraziym/mcp`. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: semver with `-beta` prereleases.

## Unreleased

### Added

- Resources, prompts and completion in the default server: `fraziym://catalog`, `fraziym://audit/recent`, the jailed `fraziym://workspace/{path}` template, prompts `review_changes` / `orient_repo` / `debug_failure` / `find_tool`, and `completion/complete` (workspace path prefixes).
- Rich tool results: handlers may return MCP content blocks (text / image / audio / embedded resource) while string results keep the guarded `[ERROR]` convention.
- Per-call protocol context: `notifications/progress`, level-filtered `notifications/message`, and server→client `sampling/createMessage` / `elicitation/create` gated on declared client capabilities.
- Streamable HTTP SSE (SEP-1699): POST response streams, priming event with `retry`, mid-call stream close, `Last-Event-ID` replay, concurrent POST streams; legacy `Mcp-Session-Id` lifecycle including `DELETE`.
- `serve --conformance`: official-suite fixture surface (`test_*` tools/resources/prompts) driving the real protocol paths; the default product stays fixture-free.
- Verified against `@modelcontextprotocol/conformance@0.1.16`: **32/32 scenarios, 47/47 checks, 0 failed** ([artifact](./docs/conformance-2026-10-19.md)).

### Changed

- Per-product state (audit log, fix queue) moved from `~/.fraziym/mcp/` to the machine-local FRAZIYM cache — `%LOCALAPPDATA%\FRAZIYM\mcp` on Windows, `~/Library/Caches/FRAZIYM/mcp` on macOS, `$XDG_CACHE_HOME/fraziym/mcp` on Linux (`$FRAZIYM_LOCAL` or `$FRAZIYM_MCP_HOME` overrides).

### Removed

- Custom benchmark CLI, harness, caches/results, public performance tables and unsupported competitor claims. Historical evidence and caveats are in [`docs/development/benchmark-history.md`](./docs/development/benchmark-history.md). `prove`, `fuzz`, tests and conformance verification remain.

### Fixed

- `doctor` axoniz-home check now uses the unified `~/.fraziym/axoniz` (honors `$AXONIZ_HOME`) instead of the legacy `~/.axoniz`.

## 0.1.1-beta.0 — 2026-10-19

### Added

- Dual-era MCP: protocol **2026-07-28** (stateless, per-request `_meta`, `server/discover`, `Mcp-Method`/`Mcp-Name` header mirroring, `-32020`/`-32022` errors) plus legacy initialize-based clients, over stdio and Streamable HTTP.
- Gateway endpoints behind `serve --router-tools` (13): `router_ask`, `router_race`, `router_delegate`, `router_status`, `fix_verify`, `fix_shadow`, `fix_queue_pull`, `fix_queue_complete`, `brain_absolute`, `brain_pack`, `brain_remember`, `tools_discover`, `audit_tail` — 87 tools total with the flag.
- Build-time catalog (`catalog.json`): `tools/list` answers without importing any tool family; lazy per-family loading on first call.
- `prove`, `fuzz` and exploratory benchmark CLI harnesses (the benchmark harness and its claims were later removed; see [`docs/development/benchmark-history.md`](./docs/development/benchmark-history.md)).
- Shared Fraziym home: config `~/.fraziym/config.json` (top-level or `mcp` section), state `~/.fraziym/mcp/`; overrides `FRAZIYM_HOME`, `FRAZIYM_MCP_HOME`, `FRAZIYM_MCP_AUDIT`.
- Security: workspace path-arg jails, command guards, HTTP rate limiting, append-only audit log, adversarial fuzz suite (327 cases, 0 escapes).
- Distribution: `server.json` (official registry), `glama.json`, `docs/listing-kit.md`, MCPB manifest, Dockerfile, 3-OS CI matrix, CodeQL.

## 0.1.0-beta.1 — initial npm beta

- First published beta: 72 tools (files, shell, web, git, code, memory, axodex, axoniz tool groups) over stdio.
