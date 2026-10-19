# Client quickstarts

Copy-paste configs for `@fraziym/mcp`. Default is stdio: `npx -y @fraziym/mcp serve`. Add `--router-tools` for the 13 gateway endpoints (87 tools total), `--workspace <dir>` to scope file tools, `--group axoniz|xorvoid|all` to trim the surface.

## Claude Desktop

`claude_desktop_config.json` (`%APPDATA%\Claude\` on Windows, `~/Library/Application Support/Claude/` on macOS):

```json
{
  "mcpServers": {
    "fraziym": {
      "command": "npx",
      "args": ["-y", "@fraziym/mcp", "serve"]
    }
  }
}
```

Or install the MCPB bundle (`manifest.json` in this repo) for a one-click install.

## Claude Code

```sh
claude mcp add fraziym -- npx -y @fraziym/mcp serve
```

## Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "fraziym": {
      "command": "npx",
      "args": ["-y", "@fraziym/mcp", "serve"]
    }
  }
}
```

## VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "fraziym": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@fraziym/mcp", "serve"]
    }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "fraziym": {
      "command": "npx",
      "args": ["-y", "@fraziym/mcp", "serve"]
    }
  }
}
```

## Cline / Roo Code

MCP Servers panel → "Edit MCP Settings" (same `mcpServers` JSON as Cursor).

## Zed

`settings.json`:

```json
{
  "context_servers": {
    "fraziym": {
      "command": {
        "path": "npx",
        "args": ["-y", "@fraziym/mcp", "serve"]
      }
    }
  }
}
```

## Goose

`~/.config/goose/config.yaml`:

```yaml
extensions:
  fraziym:
    type: stdio
    cmd: npx
    args: ["-y", "@fraziym/mcp", "serve"]
```

## LM Studio

`~/.lmstudio/mcp.json` (or Settings → Program → Edit mcp.json):

```json
{
  "mcpServers": {
    "fraziym": {
      "command": "npx",
      "args": ["-y", "@fraziym/mcp", "serve"]
    }
  }
}
```

## Open WebUI (via mcpo)

```sh
uvx mcpo -- npx -y @fraziym/mcp serve
```

## Remote / containers (Streamable HTTP)

Serve over HTTP instead of stdio (always set a token when exposing beyond localhost):

```sh
fraziym-mcp serve --http --host 127.0.0.1 --port 7777 --token "$FRAZIYM_MCP_TOKEN"
```

```sh
docker run --rm -p 7777:7777 ghcr.io/akik-forazi/fraziym-mcp \
  serve --http --host 0.0.0.0 --port 7777 --token "$FRAZIYM_MCP_TOKEN"
```

Clients that accept a URL (Cursor, VS Code, Claude Code remote) point at `http://127.0.0.1:7777/mcp` with the `Authorization: Bearer <token>` header.

## Gateway endpoints

```json
{
  "mcpServers": {
    "fraziym": {
      "command": "npx",
      "args": ["-y", "@fraziym/mcp", "serve", "--router-tools"]
    }
  }
}
```

Provider keys live in `~/.fraziym/config.json` (prefer `apiKeyEnv` references over inline keys — see README "Gateway" section).
