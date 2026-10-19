/**
 * Axodex tools — graph-powered code intelligence via the axodex CLI.
 *
 * Unlike axoniz's wrapper (which quotes argv into a shell), this runner
 * spawns the real `node dist/cli/index.js` entry with argv arrays, so symbol
 * names and queries can never inject commands. Resolution order:
 *
 *   1. `@fraziym/axodex` in the resolution root (the version axoniz expects)
 *   2. `axodex` on PATH (npm global; Windows .cmd shim is parsed, not shelled)
 *   3. `npx --no-install @fraziym/axodex` (offline-safe fallback)
 *
 * mode "core": query/context/impact/smart_read/status (xorvoidTools default).
 * mode "full": the complete 7-tool axoniz surface (+ detect_changes/analyze).
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { argInt, argStr } from "../core/args.ts";
import { execCapture, findOnPath, isWindows, parseCmdShim } from "../core/exec.ts";
import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

export type AxodexToolsMode = "core" | "full";

const NOT_FOUND = `[AXODEX ERROR] axodex CLI not found on PATH.
  Install with:  npm install -g @fraziym/axodex
  Or:           axoniz install axodex`;

export interface AxodexInvocation {
  cmd: string;
  base: string[];
  via: string;
}

let cached: AxodexInvocation | null | undefined;

/** Resolve the best axodex invocation right now (memoized). Exposed for doctor/bench. */
export function axodexInvocation(): AxodexInvocation | null {
  return resolveAxodex();
}

function resolveAxodex(): AxodexInvocation | null {
  if (cached !== undefined) return cached;
  cached = null;

  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("@fraziym/axodex/package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.axodex;
    if (rel) {
      const script = path.resolve(path.dirname(pkgJson), rel);
      if (fs.existsSync(script)) {
        cached = { cmd: process.execPath, base: [script], via: "package" };
        return cached;
      }
    }
  } catch {
    /* fall through to PATH */
  }

  const bin = findOnPath("axodex");
  if (bin) {
    if (isWindows && /\.(cmd|bat)$/i.test(bin)) {
      const shim = parseCmdShim(bin);
      if (shim) {
        cached = { cmd: shim.node, base: [shim.script], via: "path-shim" };
        return cached;
      }
    } else {
      cached = { cmd: bin, base: [], via: "path" };
      return cached;
    }
  }

  const npx = findOnPath("npx");
  if (npx) {
    if (isWindows && /\.(cmd|bat)$/i.test(npx)) {
      const shim = parseCmdShim(npx);
      if (shim) {
        cached = { cmd: shim.node, base: [shim.script, "--no-install", "@fraziym/axodex"], via: "npx" };
        return cached;
      }
    } else {
      cached = { cmd: npx, base: ["--no-install", "@fraziym/axodex"], via: "npx" };
      return cached;
    }
  }

  return cached;
}

/** Free-text axodex argument: no leading dash (no flag smuggling), hard cap. */
function freeText(value: string, what: string, maxLen = 512): string {
  const v = value.trim();
  if (!v) throw new Error(`${what} must not be empty`);
  if (v.startsWith("-")) throw new Error(`${what} must not start with "-"`);
  if (v.includes("\0")) throw new Error(`${what} contains a NUL byte`);
  if (v.length > maxLen) throw new Error(`${what} exceeds ${maxLen} characters`);
  return v;
}

function directionOf(value: string): "upstream" | "downstream" {
  const v = value.trim() || "upstream";
  if (v !== "upstream" && v !== "downstream") {
    throw new Error(`direction must be "upstream" or "downstream"`);
  }
  return v;
}

async function run(workspace: string, argv: string[]): Promise<string> {
  const inv = resolveAxodex();
  if (!inv) return NOT_FOUND;
  const res = await execCapture(inv.cmd, [...inv.base, ...argv], {
    cwd: workspace,
    timeoutMs: 120_000,
  });
  if (res.spawnError) return `[AXODEX ERROR] ${res.spawnError} spawning axodex (via ${inv.via})`;
  if (res.timedOut) return "[AXODEX ERROR] Operation timed out (120s).";
  if (res.code !== 0) {
    const errOut = (res.stderr || res.stdout).trim();
    if (errOut.includes("No indexed repositories found")) {
      return "[AXODEX ERROR] No index found. Run 'axodex_analyze' first.";
    }
    return `[AXODEX ERROR] ${errOut}`;
  }
  return res.stdout.trim();
}

/**
 * Axodex runner bound to a workspace — same shape as axoniz's AxodexTools
 * so callers (misc tools, tests) swap in without changes.
 */
export class AxodexRunner {
  private readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  /** Semantic search for concepts or execution flows. */
  async query(query: string, limit = 10): Promise<string> {
    const q = freeText(query, "query");
    const n = Math.min(Math.max(limit, 1), 100);
    return run(this.workspace, ["query", q, "--limit", String(n)]);
  }

  /** Get full context for a symbol (callers, callees, flows). */
  async context(name: string): Promise<string> {
    return run(this.workspace, ["context", freeText(name, "name")]);
  }

  /** Analyze blast radius of changing a symbol. */
  async impact(target: string, direction = "upstream"): Promise<string> {
    return run(this.workspace, [
      "impact",
      freeText(target, "target"),
      "--direction",
      directionOf(direction),
    ]);
  }

  /** Symbol definition plus its immediate graph neighbours. */
  async smart_read(symbolName: string): Promise<string> {
    const ctx = await this.context(symbolName);
    if (ctx.includes("[AXODEX ERROR]")) return ctx;
    return `[Architectural Slice: ${symbolName}]\n${ctx}`;
  }

  /** Verify which symbols and processes are affected by current edits. */
  async detect_changes(): Promise<string> {
    return run(this.workspace, ["detect_changes"]);
  }

  /** Force a refresh of the codebase index. */
  async analyze(): Promise<string> {
    return run(this.workspace, ["analyze"]);
  }

  /** Check index freshness and repo stats. */
  async status(): Promise<string> {
    return run(this.workspace, ["status"]);
  }

  /** camelCase alias — `detect_changes` is kept verbatim for tool naming. */
  async detectChanges(): Promise<string> {
    return this.detect_changes();
  }
}

export function registerAxodexTools(
  tb: Toolbox,
  ax: AxodexRunner,
  mode: AxodexToolsMode = "core",
): void {
  tb.register(
    "axodex_query",
    "Semantic search across the codebase knowledge graph (concepts, flows).",
    { query: S("Concept or question to search for"), limit: I("Max hits (default 10)") },
    ["query"],
    (args) => ax.query(argStr(args, "query"), argInt(args, "limit", 10)),
    { readOnly: true },
  );

  tb.register(
    "axodex_context",
    "Get architectural context for a named symbol (callers, callees, process).",
    { name: S("Symbol name") },
    ["name"],
    (args) => ax.context(argStr(args, "name")),
    { readOnly: true },
  );

  tb.register(
    "axodex_impact",
    "Blast-radius analysis: what breaks if this symbol changes.",
    { target: S("Symbol to analyze"), direction: S('"upstream" (default) or "downstream"') },
    ["target"],
    (args) => ax.impact(argStr(args, "target"), argStr(args, "direction", "upstream")),
    { readOnly: true },
  );

  tb.register(
    "axodex_smart_read",
    "Read a symbol with its graph context instead of raw file text.",
    { symbol: S("Symbol name") },
    ["symbol"],
    (args) => ax.smart_read(argStr(args, "symbol")),
    { readOnly: true },
  );

  tb.register(
    "axodex_status",
    "Index freshness / stats for the workspace's code graph.",
    {},
    [],
    () => ax.status(),
    { readOnly: true },
  );

  if (mode !== "full") return;

  tb.register(
    "axodex_detect_changes",
    "Verify which symbols and execution flows are affected by uncommitted edits.",
    {},
    [],
    () => ax.detect_changes(),
    { readOnly: true },
  );

  tb.register(
    "axodex_analyze",
    "Force a full refresh of the workspace's code graph index.",
    {},
    [],
    () => ax.analyze(),
  );
}
