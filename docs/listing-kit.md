# Listing kit — getting @fraziym/mcp into the indexes

Status 2026-10-19: **blocked on `npm publish`** (needs the account OTP). Everything else is prepped and waiting.

The pipeline is a chain — each step unlocks the next:

1. **npm publish** `@fraziym/mcp@0.1.1-beta.0` — `mcpName` and `server.json` are already committed; the registry proves package ownership through them.
2. **Official MCP Registry** (`mcp-publisher`) — the master record. Glama ingests it, PulseMCP will pick it up automatically when submissions reopen, mcp.so is increasingly fed from it.
3. **Glama** claim (auto-listed via step 2; claim + badge improves the score).
4. **awesome-mcp-servers PR** — needs the Glama badge from step 3.
5. **mcp.so** web form (manual browser, GitHub sign-in).
6. Optional: **Plug and Ship** (free, open-source only), **Smithery** (needs a hosted HTTPS endpoint or an MCPB bundle — later).

## 1. npm publish

```powershell
cd C:\Users\user\akik\programing\axo\mcp
npm publish            # web OTP prompt
npm dist-tag add @fraziym/mcp@0.1.1-beta.0 beta
npm view @fraziym/mcp version   # verify
```

## 2. Official MCP Registry

Download the Windows publisher binary from https://github.com/modelcontextprotocol/registry/releases (asset `mcp-publisher_windows_amd64.tar.gz`), extract, then:

```powershell
.\mcp-publisher.exe login github     # opens a browser: GitHub device code — Akik-Forazi must authorize
.\mcp-publisher.exe publish          # reads .\server.json
```

Verify:

```powershell
curl.exe "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Akik-Forazi/mcp"
```

- If validation complains about the name: the authenticated GitHub username must match the `io.github.<user>/` namespace exactly (try lowercase `io.github.akik-forazi/mcp` — keep `version` identical in `package.json` and `server.json`).
- Published versions are immutable; to fix anything, bump the version in *both* files and re-publish.
- `mcpName` in `package.json` must equal `server.json` `name` — it does.

## 3. Glama

- Auto-ingested from the registry (superset, minutes to days).
- `glama.json` is committed (`maintainers: ["Akik-Forazi"]`).
- Claim the listing at `https://glama.ai/mcp/servers` (search "Fraziym MCP") → sign in with GitHub → **Claim ownership**. Glama scores tool-definition quality (60% mean + 40% minimum) — our tool descriptions are already written for this.

## 4. awesome-mcp-servers PR

Target: https://github.com/punkpeye/awesome-mcp-servers → Developer Tools section, alphabetical. One line:

```md
- [Akik-Forazi/MCP](https://github.com/Akik-Forazi/MCP) [![Akik-Forazi/MCP MCP server](https://glama.ai/mcp/servers/Akik-Forazi/MCP/badges/score.svg)](https://glama.ai/mcp/servers/Akik-Forazi/MCP) 📇 🏠 🍎 🪟 🐧 - Fastest, most secure MCP toolbelt server: 74 tools (files, shell, web, code, git, memory) + router/fix/brain gateway, protocol 2026-07-28 + legacy.
```

- The bot checks: `owner/repo` name, GitHub link, Glama score badge (step 3 must be live first), permitted emojis (📇 TypeScript, 🏠 local, 🍎🪟🐧 OS). PR title: `Add Akik-Forazi/MCP`. Automated-agent PRs opt into a fast lane by appending `🤖🤖🤖` to the title.
- Median merge time is ~10 days; the bot labels the PR with what's missing — fix by pushing to the same branch.

## 5. mcp.so

https://mcp.so/submit — sign in with the GitHub account that owns the repo:

- Type: `MCP server` (local stdio via npx)
- Name: `Fraziym MCP`
- Repository URL: `https://github.com/Akik-Forazi/MCP`
- Config to paste:

```json
{"mcpServers":{"fraziym":{"command":"npx","args":["-y","@fraziym/mcp","serve"]}}}
```

- Tags: `mcp-server`, `tools`, `file-system`, `git`, `shell`, `memory`, `router`
- Free submission goes through review; the $39 option only buys speed + badge (not needed).

## 6. Notes on the rest

- **PulseMCP** — submissions paused (last checked 2026-10-17); it ingests the official registry automatically when they reopen. Nothing to do.
- **Plug and Ship** — free listing for open-source repos: https://plugandship.dev/submit. The README now carries an `npx` install line in a code block for their parser.
- **Smithery** — requires a public HTTPS Streamable HTTP endpoint (we ship `serve --http`, but hosting is a separate decision) or an MCPB bundle. Revisit after 0.1.1 goes stable.
- **Agent-bench leaderboards** (MCPMark / MCP-Universe) — separate track; needs a live agent loop with provider keys and long runs. The `router_*` gateway endpoints are the hook once keys exist in the shared `~/.fraziym/config.json`.

## Canonical fields (reuse everywhere)

- Name: `Fraziym MCP` (package `@fraziym/mcp`)
- Repo: `https://github.com/Akik-Forazi/MCP`
- Registry id: `io.github.Akik-Forazi/mcp`
- One-liner: `Fastest, most secure MCP toolbelt server: 74 tools + router/fix/brain gateway (2026-07-28 + legacy).`
- Badge: `https://glama.ai/mcp/servers/Akik-Forazi/MCP/badges/score.svg`
