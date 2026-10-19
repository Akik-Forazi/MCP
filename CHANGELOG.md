# Changelog

All notable changes to `@fraziym/mcp`. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: semver with `-beta` prereleases.

## 0.1.1-beta.0 — 2026-10-19

### Added

- Dual-era MCP: protocol **2026-07-28** (stateless, per-request `_meta`, `server/discover`, `Mcp-Method`/`Mcp-Name` header mirroring, `-32020`/`-32022` errors) plus legacy initialize-based clients, over stdio and Streamable HTTP.
- Gateway endpoints behind `serve --router-tools` (13): `router_ask`, `router_race`, `router_delegate`, `router_status`, `fix_verify`, `fix_shadow`, `fix_queue_pull`, `fix_queue_complete`, `brain_absolute`, `brain_pack`, `brain_remember`, `tools_discover`, `audit_tail` — 87 tools total with the flag.
- Build-time catalog (`catalog.json`): `tools/list` answers without importing any tool family; lazy per-family loading on first call.
- `bench`, `prove`, `fuzz` CLI harnesses with committed raw artifacts (`docs/bench-2026-10-19.json`, `prove-report.json`, `fuzz-report.json`).
- Shared Fraziym home: config `~/.fraziym/config.json` (top-level or `mcp` section), state `~/.fraziym/mcp/`; overrides `FRAZIYM_HOME`, `FRAZIYM_MCP_HOME`, `FRAZIYM_MCP_AUDIT`.
- Security: workspace path-arg jails, command guards, HTTP rate limiting, append-only audit log, adversarial fuzz suite (327 cases, 0 escapes).
- Distribution: `server.json` (official registry), `glama.json`, `docs/listing-kit.md`, MCPB manifest, Dockerfile, 3-OS CI matrix, CodeQL.

### Changed

- README performance claims reconciled with the independent [TechFuelHQ 2026-08-19 dataset](https://techfuelhq.com/data/mcp-server-bench/) for competitor numbers.

## 0.1.0-beta.1 — initial npm beta

- First published beta: 72 tools (files, shell, web, git, code, memory, axodex, axoniz tool groups) over stdio.
