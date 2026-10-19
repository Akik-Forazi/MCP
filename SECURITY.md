# Security

`@fraziym/mcp` runs tools with the privileges of the user who launched the server. This document describes the defenses, the defaults, and how to report issues.

## Threat model

The server assumes:

1. **The MCP client (and every model behind it) is untrusted input.** Tool names, arguments and transport frames are hostile until validated.
2. **The workspace is the only writable surface.** Everything reachable only by escaping the workspace root is a bug.
3. **Local HTTP may be reachable by hostile web pages** (DNS rebinding) and, if bound beyond loopback, by the network.
4. **Secrets must never round-trip.** Provider keys, bearer tokens and arg values are never echoed into tool results, logs or audit records.

Out of scope: a compromised host account, a malicious shared `~/.fraziym/config.json` (trusted user configuration — treat it like `.bashrc`), and models that misuse tools *within* their granted permissions (use `--read-only` / `--no-network` allowlists for that).

## Defenses in place

### Workspace jail (`src/core/guard.ts`, `src/core/path-args.ts`)

- Every path argument is resolved and checked against the realpath of the workspace root — `..`, symlink escapes, UNC/device paths (`\\?\`, `\\.\`), 8.3 aliases and case tricks are all resolved *before* comparison.
- Path arguments are capped at 4096 chars, published in every tool schema as `maxLength: 4096`, and enforced *before dispatch*: violations return `-32602 Invalid params`, never reach the handler. A global 2 MiB argument cap sits above that.
- Outputs are truncated (64 KiB per result by default) so a hostile file cannot blow up the client; streams are bounded the same way.
- `--allow-outside` disables the jail for trusted power users; it is off by default.

### `fuzz` — regression-tested jail

`npm run fuzz` throws a deterministic pack at the jail: the CVE-2025-53109/53110-shaped traversal corpus, Windows device names (`CON`, `NUL.txt`, `COM1`, `LPT9.log`), device namespaces, `%2e%2e` encodings, mixed separators, NUL injection, 5000-char and 2 MiB paths, plus 300 seeded random paths. Current result: **0 breaches** (`fuzz-report.json`).

### Command execution

- Tools that shell out (git, npm, axodex) build argv arrays with `execFile` — no `shell: true` interpolation of model-controlled strings. Git refs/remotes are passed as arguments, with option-injection guards (`--` separators, rejection of leading `-` / `:` values) closing CVE-2025-68143/68144/68145.
- `shell_run` is the *only* arbitrary-command tool and is annotated destructive + network; strip it with `--read-only` whenever the model does not need it.

### HTTP transport (`src/protocol/http.ts`)

- **Loopback by default**: binds `127.0.0.1` unless `--host` says otherwise. (A Grafana-MCP-style `0.0.0.0` default is exactly the CVE-2025-4xxxx exposure class we refuse.)
- **Origin validation** on every request that carries one (DNS-rebinding defense), `MCP-Protocol-Version` header checks, per-request `_meta` identity checks (`-32020` HeaderMismatch).
- **POST-only, stateless**: no session ids to steal, no GET stream to hijack, no replayable server state.
- **Optional bearer auth** (`--token SECRET`): constant-time compare; 401 responses carry `WWW-Authenticate: Bearer resource_metadata="…"` and RFC 9728 Protected Resource Metadata is served at `/.well-known/oauth-protected-resource` (with an empty `authorization_servers` — static tokens are not OAuth and we will not advertise an AS we don't have).
- **Rate limit** on `tools/call` per client IP (token bucket, default burst 30 / 15 per second → `429` + `Retry-After`), tunable with `--rate-limit`.
- Request body capped (413), wrong content type rejected (415), CORS headers only echoed for the configured origin, cancellation on client disconnect.

### Audit log

`~/.fraziym/mcp/audit.jsonl` (or `$FRAZIYM_MCP_HOME`, `$FRAZIYM_MCP_AUDIT`) records tool name, arg hash, timing and truncation — values are **redacted** (secret-looking keys and `sk-…`/`ghp_…`/`Bearer …` patterns replaced) and the audit path never throws. Tail it with the `audit_tail` gateway endpoint.

### Supply chain

- Runtime dependency is a single scoped package (`@fraziym/axoniz`); tool classes are imported lazily per family. The Windows exe launcher is built from `scripts/launcher.cs` in-repo.
- No postinstall scripts in this package; `npm run prove` (74/74 tools dispatch cleanly) and the 89-test suite run against the pinned dependency.

## Reporting a vulnerability

Open a private security advisory on GitHub (**Akik-Forazi/MCP → Security → Report a vulnerability**) or email `akikfaraji@gmail.com`. Please include a minimal repro; expect an acknowledgement within 72 hours. We will credit reporters in the release notes unless asked otherwise.
