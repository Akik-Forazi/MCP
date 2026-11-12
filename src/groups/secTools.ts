/**
 * secTools — Security tool group for xorgis.
 *
 * Composed from core file/shell/web/code/computer tools plus CLI-bridge
 * wrappers for xorgis binaries. All handlers are guarded by default.
 * Destructive operations (encrypt/decrypt) require explicit opt-in.
 *
 * Usage:
 *   import { secTools } from "@fraziym/mcp/groups/secTools";
 *   const tools = secTools({ workspace: "/path/to/repo" });
 *   chat({ tools: tools.specs() });
 *   await tools.call("xorgis_scan", { path: "src" });
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { CodeTools, ComputerTools, FileTools, ShellTools, WebTools } from "../impl/index.ts";

import { argStr } from "../core/args.ts";
import { execCapture, findOnPath } from "../core/exec.ts";
import { guardToolbox, type GuardOptions } from "../core/guard.ts";
import { Toolbox } from "../core/toolbox.ts";
import { AxodexRunner, registerAxodexTools } from "../tools/axodex.ts";
import { registerCodeTools } from "../tools/code.ts";
import { registerComputerTools } from "../tools/computer.ts";
import { registerFileTools } from "../tools/files.ts";
import { registerShellTools } from "../tools/shell.ts";
import { registerAgentRuntimeTools } from "../tools/agentRuntime.ts";
import { registerGoalTools } from "../tools/goals.ts";
import { registerWebTools } from "../tools/web.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

// CLI-bridge resolution: resolve binary from PATH, node_modules/.bin, or npx
function resolveQaBinary(name: string): string | null {
  const tryPaths = [
    path.join(process.cwd(), "node_modules", ".bin", name),
    path.join(process.cwd(), "node_modules", "@fraziym", name, "dist", "cli.js"),
    path.join(process.cwd(), "node_modules", "@fraziym", name, "dist", "index.js"),
  ];
  for (const p of tryPaths) {
    if (fs.existsSync(p)) return p;
  }
  const onPath = findOnPath(name);
  if (onPath) return onPath;
  const npxPath = findOnPath("npx");
  if (npxPath) return npxPath;
  return null;
}

// CLI-bridge wrapper that spawns the binary with argv arrays (no shell)
async function runQaTool(binary: string, args: string[]): Promise<string> {
  const resolved = resolveQaBinary(binary);
  if (!resolved) {
    return `[SEC ERROR] ${binary} not found. Install @fraziym/${binary} or ensure it's on PATH.`;
  }
  const isNpx = resolved.includes("npx") || resolved.endsWith("npx");
  const finalArgs = isNpx ? ["--no-install", `@fraziym/${binary}`, ...args] : args;
  const finalBin = isNpx ? resolved : resolved;
  const result = await execCapture(finalBin, finalArgs, { timeoutMs: 120000 });
  if (result.spawnError) return `[SEC ERROR] spawn: ${result.spawnError}`;
  if (result.code !== 0) return `[SEC ERROR] exit ${result.code}: ${result.stderr || result.stdout}`;
  return result.stdout || result.stderr || "OK";
}

export function secTools(opts: { workspace: string; guard?: Partial<GuardOptions> | false }): Toolbox {
  const ws = opts.workspace;
  const tb = new Toolbox();

  // Register core tool types (same pattern as axonizTools)
  registerFileTools(tb, new FileTools(ws));
  registerShellTools(tb, new ShellTools(ws));
  registerWebTools(tb, new WebTools(ws));
  registerCodeTools(tb, new CodeTools(ws));
  registerComputerTools(tb, new ComputerTools(ws));
  registerAxodexTools(tb, new AxodexRunner(ws), "full");

  // xorgis tools via CLI bridge
  tb.register(
    "xorgis_scan",
    "Run xorgis security scan on the given path.",
    { path: S("Path to scan (relative to workspace)") },
    ["path"],
    (args) => runQaTool("xorgis", ["scan", argStr(args, "path")]),
    { readOnly: true },
  );

  tb.register(
    "xorgis_harden",
    "Run xorgis hardening on the given path.",
    { path: S("Path to harden (relative to workspace)") },
    ["path"],
    (args) => runQaTool("xorgis", ["harden", argStr(args, "path")]),
  );

  tb.register(
    "xorgis_audit",
    "Run xorgis audit on the given path.",
    { path: S("Path to audit (relative to workspace)") },
    ["path"],
    (args) => runQaTool("xorgis", ["audit", argStr(args, "path")]),
    { readOnly: true },
  );

  tb.register(
    "xorgis_encrypt",
    "Encrypt files using xorgis. DESTRUCTIVE — requires explicit opt-in.",
    { path: S("Path to encrypt (relative to workspace)") },
    ["path"],
    (args) => runQaTool("xorgis", ["encrypt", argStr(args, "path")]),
    { destructive: true },
  );

  tb.register(
    "xorgis_decrypt",
    "Decrypt files using xorgis. DESTRUCTIVE — requires explicit opt-in.",
    { path: S("Path to decrypt (relative to workspace)") },
    ["path"],
    (args) => runQaTool("xorgis", ["decrypt", argStr(args, "path")]),
    { destructive: true },
  );

  tb.register(
    "xorgis_pqverify",
    "Verify post-quantum crypto (ML-KEM/ML-DSA/SLH-DSA/BLAKE3) signatures.",
    { path: S("Path to verify (relative to workspace)") },
    ["path"],
    (args) => runQaTool("xorgis", ["pqverify", argStr(args, "path")]),
    { readOnly: true },
  );

  // xorgis_kvs — verify key-value store integrity (Merkle chain audit)
  tb.register(
    "xorgis_kvs",
    "Verify key-value store integrity via Merkle chain audit.",
    { path: S("Path to key-value store (relative to workspace)") },
    ["path"],
    (args) => runQaTool("xorgis", ["verify", argStr(args, "path")]),
    { readOnly: true },
  );

  // Agent-runtime stubs (live-agent tools until the agent instance is reachable)
  registerAgentRuntimeTools(tb, { workspace: ws });
  // Goal tools (bound to axoniz GoalService when the optional peer is installed)
  registerGoalTools(tb);

  // Guard tuning
  if (opts.guard !== false) {
    return guardToolbox(tb, { root: ws, ...opts.guard });
  }
  return tb;
}