#!/usr/bin/env node
/**
 * fraziym-mcp — the @fraziym/mcp toolbelt CLI.
 * Run `fraziym-mcp help` for the command list.
 *
 * Fast paths matter here: `version`, `help`, `tools` and `serve` startup must
 * never import the tool runtime (axoniz, memory, computer). Heavy modules are
 * loaded with dynamic `import()` only in the branches that need them.
 */

import process from "node:process";

import type { ToolGroup } from "../core/catalog.ts";

const HELP = `fraziym-mcp — @fraziym/mcp toolbelt CLI

  fraziym-mcp serve [--group axoniz|xorvoid|all] [--workspace PATH]
                    [--read-only] [--no-network] [--allow-outside] [--no-audit]
                    [--http] [--port 7777] [--host 127.0.0.1] [--token SECRET]
                    [--rate-limit 30|off] [--router-tools]
      MCP server over stdio (default) or Streamable HTTP (protocol 2026-07-28
      stateless + legacy initialize; Origin-checked, loopback-bound by default,
      tools/call rate-limited over HTTP). --router-tools additionally
      advertises the gateway endpoints (router_*, fix_*, brain_*, ...).

  fraziym-mcp tools [--group ...] [--json]
      List the tools in a group (default: all). Answered from the catalog.

  fraziym-mcp bench [--runs 3] [--competitors] [--json]
      Measure cold-start (spawn → initialize), tools/list latency, tool count
      and RSS; --competitors also benchmarks common npx MCP servers.

  fraziym-mcp prove [--out prove-report.json] [--include-input]
      Dispatch every catalog tool once in a throwaway workspace and classify
      the outcome (ok / stub / env-error). Fails on any unreachable tool.

  fraziym-mcp fuzz [--cases 300] [--seed 1337] [--out fuzz-report.json]
      Throw the adversarial path pack + seeded random paths at the workspace
      jail; exits 1 on any escape.

  fraziym-mcp call <tool> [json-args] [--group ...] [--workspace PATH]
      Invoke one tool directly (loads only that tool's family).

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
      const { serve } = await import("./serve.ts");
      const portRaw = flagString(flags, "port");
      const port = portRaw === undefined ? undefined : Number.parseInt(portRaw, 10);
      if (portRaw !== undefined && (port === undefined || Number.isNaN(port))) {
        process.stderr.write(`invalid --port: ${portRaw}\n`);
        return 2;
      }
      const rateLimitRaw = flagString(flags, "rate-limit");
      const rateLimitBurst =
        rateLimitRaw === undefined ? undefined : rateLimitRaw === "off" ? 0 : Number.parseInt(rateLimitRaw, 10);
      if (rateLimitRaw !== undefined && (rateLimitBurst === undefined || Number.isNaN(rateLimitBurst) || rateLimitBurst < 0)) {
        process.stderr.write(`invalid --rate-limit: ${rateLimitRaw} (use a burst count or "off")\n`);
        return 2;
      }
      await serve({
        workspace,
        group: groupOf(flags),
        readOnly: flagBool(flags, "read-only"),
        noNetwork: flagBool(flags, "no-network"),
        allowOutside: flagBool(flags, "allow-outside"),
        audit: !flagBool(flags, "no-audit"),
        http: flagBool(flags, "http"),
        port,
        host: flagString(flags, "host"),
        token: flagString(flags, "token"),
        rateLimitBurst,
        routerTools: flagBool(flags, "router-tools"),
      });
      return 0;
    }

    case "bench": {
      const { bench } = await import("./bench.ts");
      const runsRaw = flagString(flags, "runs");
      const runs = runsRaw === undefined ? 3 : Number.parseInt(runsRaw, 10);
      if (Number.isNaN(runs) || runs < 1) {
        process.stderr.write(`invalid --runs: ${runsRaw}\n`);
        return 2;
      }
      return await bench({
        workspace,
        runs,
        json: flagBool(flags, "json"),
        competitors: flagBool(flags, "competitors"),
      });
    }

    case "prove": {
      const { prove } = await import("./prove.ts");
      return await prove({
        out: flagString(flags, "out") ?? "prove-report.json",
        includeInput: flagBool(flags, "include-input"),
      });
    }

    case "fuzz": {
      const { fuzz } = await import("./fuzz.ts");
      const casesRaw = flagString(flags, "cases");
      const cases = casesRaw === undefined ? 300 : Number.parseInt(casesRaw, 10);
      if (Number.isNaN(cases) || cases < 0) {
        process.stderr.write(`invalid --cases: ${casesRaw}\n`);
        return 2;
      }
      const seedRaw = flagString(flags, "seed");
      const seed = seedRaw === undefined ? 1337 : Number.parseInt(seedRaw, 10);
      if (Number.isNaN(seed)) {
        process.stderr.write(`invalid --seed: ${seedRaw}\n`);
        return 2;
      }
      return await fuzz({ out: flagString(flags, "out") ?? "fuzz-report.json", cases, seed });
    }

    case "tools": {
      const group = groupOf(flags);
      const { LazyToolHost } = await import("../core/host.ts");
      const host = new LazyToolHost({ workspace, group });
      if (flagBool(flags, "json")) {
        out(
          JSON.stringify(
            {
              group,
              count: host.names().length,
              tools: host.catalogTools().map((t) => ({
                name: t.name,
                description: t.description,
                ...t.meta,
              })),
            },
            null,
            2,
          ),
        );
      } else {
        for (const t of host.catalogTools()) {
          const tags = [t.meta.destructive ? "destructive" : "", t.meta.network ? "network" : ""]
            .filter(Boolean)
            .join(",");
          out(`${t.name.padEnd(24)} ${tags ? `[${tags}]` : ""}`);
        }
        out(`${String(host.names().length)} tools`);
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
      const { LazyToolHost } = await import("../core/host.ts");
      const host = new LazyToolHost({
        workspace,
        group: groupOf(flags),
        guard: { audit: false },
      });
      const result = await host.call(tool, args);
      out(result);
      return result.startsWith("[ERROR]") ? 1 : 0;
    }

    case "doctor": {
      const { doctor } = await import("./doctor.ts");
      return doctor();
    }

    case "install": {
      const client = positionals[0];
      if (client !== "claude" && client !== "cursor") {
        process.stderr.write("usage: fraziym-mcp install claude|cursor [--write]\n");
        return 2;
      }
      const { installClient } = await import("./install.ts");
      installClient(client, flagBool(flags, "write"));
      return 0;
    }

    case "version":
    case "--version":
    case "-v": {
      const { pkgVersion } = await import("./version.ts");
      out(pkgVersion());
      return 0;
    }

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
