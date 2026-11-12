/**
 * Axodex Native Tools — graph-powered code intelligence (TypeScript port).
 *
 * Connects AXONIZ to the Axodex CLI. As of v0.3.4+, axodex is its own
 * npm package (@fraziym/axodex) — installed globally via
 * `npm install -g @fraziym/axodex`. The binary lands on PATH and this
 * module just invokes it.
 *
 * Resolution order (memoized per-process):
 *
 *   1. `axodex` on PATH (preferred — global npm install)
 *   2. `npx @fraziym/axodex` (auto-fallback — slower, no global install)
 *
 * To install axodex:
 *   npm install -g @fraziym/axodex
 *   # or:
 *   axoniz install axodex  # runs the above command automatically
 *
 * Bundling inside the AXONIZ repo is intentionally NOT supported anymore.
 * It added 5800+ files of overhead to the AXONIZ npm package and never
 * got the binary on PATH correctly. The standalone @fraziym/axodex
 * package is the single source of truth — one version, one binary,
 * published independently at https://www.npmjs.com/package/@fraziym/axodex.
 *
 * Ported from `axoniz/tools/axodex_tools.py`.
 */

import { error, info } from "./core/debug.ts";
import { errText, resolveCommand, runCaptured } from "./_internal.ts";

/* ── engine discovery ─────────────────────────────────────────────────────── */

/**
 * Resolved axodex invocation. `cmd` is the argv prefix to prepend to any
 * user-supplied args. `via` is a human-readable hint for log lines.
 */
interface AxodexInvocation {
  cmd: string[];
  via: string;
}

let cachedInvocation: AxodexInvocation | null = null;

/**
 * Find the best way to invoke axodex right now. Memoized per-process so
 * repeated calls don't re-probe.
 *
 *   1. `axodex` on PATH (preferred — installed via `npm install -g @fraziym/axodex`)
 *   2. `npx @fraziym/axodex` (auto-fallback — no install required)
 */
export function resolveAxodex(): AxodexInvocation | null {
  if (cachedInvocation) return cachedInvocation;

  // 1. Global axodex binary on PATH
  const axodexBin = resolveCommand("axodex");
  if (axodexBin) {
    cachedInvocation = {
      cmd: [axodexBin],
      via: "global-npm",
    };
    return cachedInvocation;
  }

  // 2. npx @fraziym/axodex (auto-fallback)
  const npxBin = resolveCommand("npx");
  if (npxBin) {
    cachedInvocation = {
      cmd: [npxBin, "@fraziym/axodex"],
      via: "npx-fallback",
    };
    return cachedInvocation;
  }

  cachedInvocation = null;
  return null;
}

/** Legacy exported constant — kept for backwards-compat with old callers.
 *  Returns null since axodex is no longer bundled inside the AXONIZ repo. */
export const AXODEX_ROOT: string | null = null;
export const AXODEX_CLI: string | null = null;

export class AxodexTools {
  readonly workspace: string;

  constructor(workspace = ".") {
    this.workspace = workspace;
    this._ensure_built();
  }

  /**
   * Resolve the axodex CLI. If nothing resolves, log a clear diagnostic
   * explaining how to install axodex via npm.
   */
  async _ensure_built(): Promise<void> {
    const inv = resolveAxodex();
    if (inv) {
      info(`[Axodex] resolved via ${inv.via}`);
      return;
    }
    error(
      `[Axodex] CLI not found on PATH.\n` +
        `  Install with one of:\n` +
        `    npm install -g @fraziym/axodex     (recommended — global install)\n` +
        `    axoniz install axodex              (same thing, via AXONIZ installer)\n` +
        `  Then run 'axodex --help' to verify.`,
    );
  }

  /** Best-effort probe to confirm axodex is actually invocable. */
  private async _probe(): Promise<number | null> {
    const inv = resolveAxodex();
    if (!inv) return null;
    try {
      const res = await runCaptured(quoteArgv([...inv.cmd, "--help"]), {
        cwd: this.workspace,
        timeoutMs: 60_000,
      });
      return res.timedOut ? null : res.code;
    } catch {
      return null;
    }
  }

  /** Execute an axodex command and return stdout. */
  async _run(cmd: string[]): Promise<string> {
    const inv = resolveAxodex();
    if (!inv) {
      return (
        `[AXODEX ERROR] axodex CLI not found on PATH.\n` +
        `  Install with:  npm install -g @fraziym/axodex\n` +
        `  Or:           axoniz install axodex`
      );
    }
    const fullCmd: string[] = [...inv.cmd, ...cmd];
    try {
      const res = await runCaptured(quoteArgv(fullCmd), {
        cwd: this.workspace,
        timeoutMs: 120_000,
      });
      if (res.timedOut) return "[AXODEX ERROR] Operation timed out (120s).";
      if (res.code !== 0) {
        const errOut = res.stderr || res.stdout;
        if (errOut.includes("No indexed repositories found")) {
          return "[AXODEX ERROR] No index found. Run 'axodex_analyze' first.";
        }
        return `[AXODEX ERROR] ${errOut}`;
      }
      return res.stdout.trim();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === "ENOENT") {
        return `[AXODEX ERROR] '${inv.cmd[0]}' not found. Install with: npm install -g @fraziym/axodex`;
      }
      return `[AXODEX EXCEPTION] ${errText(e)}`;
    }
  }

  /**
   * Superior read: symbol definition plus its immediate graph neighbours —
   * roughly 10x the context of a plain read for the same token budget.
   */
  async smart_read(symbolName: string): Promise<string> {
    const ctx = await this.context(symbolName);
    if (ctx.includes("[AXODEX ERROR]")) return ctx;
    return `[Architectural Slice: ${symbolName}]\n${ctx}`;
  }

  /** Semantic search for concepts or execution flows. */
  async query(query: string, limit = 10): Promise<string> {
    return this._run(["query", query, "--limit", String(limit)]);
  }

  /** Get full context for a symbol (callers, callees, flows). */
  async context(name: string): Promise<string> {
    return this._run(["context", name]);
  }

  /** Analyze blast radius of changing a symbol. */
  async impact(target: string, direction = "upstream"): Promise<string> {
    return this._run(["impact", target, "--direction", direction]);
  }

  /** Verify which symbols and processes are affected by current edits. */
  async detect_changes(): Promise<string> {
    return this._run(["detect_changes"]);
  }

  /** Force a refresh of the codebase index. */
  async analyze(): Promise<string> {
    return this._run(["analyze"]);
  }

  /** Check index freshness and repo stats. */
  async status(): Promise<string> {
    return this._run(["status"]);
  }

  /** camelCase alias — `detect_changes` is kept verbatim for tool naming. */
  async detectChanges(): Promise<string> {
    return this.detect_changes();
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * Quote an argv for the platform shell. `runCaptured` goes through a shell, and
 * Axodex arguments (symbol names, queries) routinely contain spaces.
 */
function quoteArgv(argv: string[]): string {
  if (process.platform !== "win32") {
    return argv.map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(" ");
  }
  // MSVCRT argv quoting: double backslashes that precede a quote and any
  // trailing backslash run, then wrap in double quotes.
  return argv
    .map((s) => `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`)
    .join(" ");
}
