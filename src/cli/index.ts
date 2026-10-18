#!/usr/bin/env node
/**
 * fraziym-mcp — the @fraziym/mcp toolbelt CLI.
 * Run `fraziym-mcp help` for the command list.
 */

import process from "node:process";

import { doctor } from "./doctor.ts";
import { installClient, type InstallClient } from "./install.ts";
import { serve } from "./serve.ts";
import { pkgVersion, toolboxFor, type ToolGroup } from "./util.ts";

const HELP = `fraziym-mcp — @fraziym/mcp toolbelt CLI

  fraziym-mcp serve [--group axoniz|xorvoid|all] [--workspace PATH]
                    [--read-only] [--no-network]
      MCP server over stdio (JSON-RPC 2.0) for Claude Desktop, Cursor, Zed, ...

  fraziym-mcp tools [--group ...] [--json]
      List the tools in a group (default: all).

  fraziym-mcp call <tool> [json-args] [--group ...] [--workspace PATH]
      Invoke one tool directly.

  fraziym-mcp doctor
      Check node / git / axoniz / axodex readiness.

  fraziym-mcp install claude|cursor [--write]
      Print (or merge) the MCP client config.

  fraziym-mcp version
`;

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgv(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf("=");
    if (eq !== -1) {
      flags.set(tok.slice(2, eq), tok.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(tok.slice(2), next);
      i++;
    } else {
      flags.set(tok.slice(2), true);
    }
  }
  return { positionals, flags };
}

function flagString(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagBool(flags: Map<string, string | true>, name: string): boolean {
  const v = flags.get(name);
  return v === true || v === "true";
}

function groupOf(flags: Map<string, string | true>): ToolGroup {
  const g = flagString(flags, "group");
  return g === "axoniz" || g === "xorvoid" || g === "all" ? g : "all";
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";
  const { positionals, flags } = parseArgv(argv.slice(1));
  const workspace = flagString(flags, "workspace") ?? process.cwd();

  switch (cmd) {
    case "serve": {
      if (flagBool(flags, "http")) {
        process.stderr.write("[fraziym-mcp] HTTP transport lands with the router endpoints; stdio for now.\n");
        return 1;
      }
      await serve({
        workspace,
        group: groupOf(flags),
        readOnly: flagBool(flags, "read-only"),
        noNetwork: flagBool(flags, "no-network"),
      });
      return 0;
    }

    case "tools": {
      const group = groupOf(flags);
      const tb = toolboxFor(group, workspace);
      if (flagBool(flags, "json")) {
        out(
          JSON.stringify(
            {
              group,
              count: tb.names().length,
              tools: tb.specs().map((s) => ({
                name: s.function.name,
                description: s.function.description,
                ...(tb.meta(s.function.name) ?? {}),
              })),
            },
            null,
            2,
          ),
        );
      } else {
        for (const s of tb.specs()) {
          const meta = tb.meta(s.function.name) ?? {};
          const tags = [meta.destructive ? "destructive" : "", meta.network ? "network" : ""]
            .filter(Boolean)
            .join(",");
          out(`${s.function.name.padEnd(24)} ${tags ? `[${tags}]` : ""}`);
        }
        out(`${String(tb.names().length)} tools`);
      }
      return 0;
    }

    case "call": {
      const tool = positionals[0];
      if (!tool) {
        process.stderr.write("usage: fraziym-mcp call <tool> [json-args]\n");
        return 2;
      }
      let args: Record<string, unknown> = {};
      const rawJson = positionals[1];
      if (rawJson !== undefined) {
        try {
          args = JSON.parse(rawJson) as Record<string, unknown>;
        } catch {
          process.stderr.write(`invalid json args: ${rawJson}\n`);
          return 2;
        }
      }
      const tb = toolboxFor(groupOf(flags), workspace);
      const result = await tb.call(tool, args);
      out(result);
      return result.startsWith("[ERROR]") ? 1 : 0;
    }

    case "doctor":
      return doctor();

    case "install": {
      const client = positionals[0];
      if (client !== "claude" && client !== "cursor") {
        process.stderr.write("usage: fraziym-mcp install claude|cursor [--write]\n");
        return 2;
      }
      installClient(client as InstallClient, flagBool(flags, "write"));
      return 0;
    }

    case "version":
    case "--version":
    case "-v":
      out(pkgVersion());
      return 0;

    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;

    default:
      process.stderr.write(`unknown command: ${cmd}\n\n`);
      process.stdout.write(HELP);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    process.stderr.write(`[fraziym-mcp] ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
