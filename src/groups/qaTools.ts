/**
 * qaTools — Quality Assurance tool group for axotest/axovb.
 *
 * Composed from core file/shell/web/code/computer tools plus CLI-bridge
 * wrappers for axotest and axovb binaries. All handlers are guarded by default.
 *
 * Usage:
 *   import { qaTools } from "@fraziym/mcp/groups/qaTools";
 *   const tools = qaTools({ workspace: "/path/to/repo" });
 *   chat({ tools: tools.specs() });
 *   await tools.call("axotest_run", { path: "src" });
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { CodeTools, ComputerTools, FileTools, ShellTools, WebTools } from "../impl/index.ts";

import { argStr } from "../core/args.ts";
import { execCapture, findOnPath, isWindows, parseCmdShim } from "../core/exec.ts";
import { guardToolbox, type GuardOptions } from "../core/guard.ts";
import { Toolbox } from "../core/toolbox.ts";
import { AxodexRunner, registerAxodexTools, type AxodexToolsMode } from "../tools/axodex.ts";
import { registerCodeTools } from "../tools/code.ts";
import { registerComputerTools } from "../tools/computer.ts";
import { registerFileTools } from "../tools/files.ts";
import { registerShellTools } from "../tools/shell.ts";
import { registerAgentRuntimeTools } from "../tools/agentRuntime.ts";
import { registerGoalTools } from "../tools/goals.ts";
import { registerWebTools } from "../tools/web.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

// CLI-bridge resolution: resolve binary from PATH, axodex package, or npx
function resolveQaBinary(name: string): string | null {
  const req = createRequire(import.meta.url);
  // Try to find via node_modules/.bin first
  const tryPaths = [
    path.join(process.cwd(), "node_modules", ".bin", name),
    path.join(process.cwd(), "node_modules", "@fraziym", name.split("-")[0], "dist", "cli.js"),
    path.join(process.cwd(), "node_modules", "@fraziym", name.split("-")[0], "dist", "index.js"),
  ];
  
  for (const p of tryPaths) {
    if (fs.existsSync(p)) return p;
  }
  
  // Try PATH resolution
  const onPath = findOnPath(name);
  if (onPath) return onPath;
  
  // Try npx as fallback
  const npxPath = findOnPath("npx");
  if (npxPath) return npxPath;
  
  return null;
}

// CLI-bridge wrapper that spawns the binary with argv arrays (no shell)
async function runQaTool(binary: string, args: string[]): Promise<string> {
  const resolved = resolveQaBinary(binary);
  if (!resolved) {
    return `[QA ERROR] ${binary} not found. Install @fraziym/${binary} or ensure it's on PATH.`;
  }
  
  // Handle npx case
  const isNpx = resolved.includes("npx") || resolved.endsWith("npx");
  const finalArgs = isNpx ? ["--no-install", `@fraziym/${binary}`, ...args] : args;
  const finalBin = isNpx ? resolved : resolved;
  
  const result = await execCapture(finalBin, finalArgs, { timeoutMs: 120000 });
  if (result.spawnError) return `[QA ERROR] spawn: ${result.spawnError}`;
  if (result.code !== 0) return `[QA ERROR] exit ${result.code}: ${result.stderr || result.stdout}`;
  return result.stdout || result.stderr || "OK";
}

export function qaTools(opts: { workspace: string; guard?: Partial<GuardOptions> | false }): Toolbox {
  const ws = opts.workspace;
  const tb = new Toolbox();
  
  // Register core tool types (same pattern as axonizTools)
  registerFileTools(tb, new FileTools(ws));
  registerShellTools(tb, new ShellTools(ws));
  registerWebTools(tb, new WebTools(ws));
  registerCodeTools(tb, new CodeTools(ws));
  registerComputerTools(tb, new ComputerTools(ws));
  registerAxodexTools(tb, new AxodexRunner(ws), "full");
  
  // axotest tools via CLI bridge
  tb.register(
    "axotest_run",
    "Run axotest test generation on the given path.",
    { path: S("Path to test (relative to workspace)") },
    ["path"],
    (args) => runQaTool("axotest", ["run", argStr(args, "path")]),
  );
  
  tb.register(
    "axotest_security",
    "Run axotest security test generation on the given path.",
    { path: S("Path to test (relative to workspace)") },
    ["path"],
    (args) => runQaTool("axotest-security", ["run", argStr(args, "path")]),
  );
  
  tb.register(
    "axotest_edge",
    "Run axotest edge case test generation on the given path.",
    { path: S("Path to test (relative to workspace)") },
    ["path"],
    (args) => runQaTool("axotest-edge", ["run", argStr(args, "path")]),
  );
  
  tb.register(
    "axotest_unit",
    "Run axotest unit test generation on the given path.",
    { path: S("Path to test (relative to workspace)") },
    ["path"],
    (args) => runQaTool("axotest-unit", ["run", argStr(args, "path")]),
  );
  
  // axovb tools via CLI bridge
  tb.register(
    "axovb_predict",
    "Predict semantic version bump from git diff.",
    { path: S("Path to git repo (relative to workspace)") },
    ["path"],
    (args) => runQaTool("axovb", ["predict", argStr(args, "path")]),
    { readOnly: true },
  );
  
  tb.register(
    "axovb_apply",
    "Apply semantic version bump to package.json.",
    { path: S("Path to package.json (relative to workspace)") },
    ["path"],
    (args) => runQaTool("axovb", ["apply", argStr(args, "path")]),
  );
  
  tb.register(
    "axovb_auto",
    "Auto-detect and apply semantic version bump.",
    { path: S("Path to git repo (relative to workspace)") },
    ["path"],
    (args) => runQaTool("axovb", ["auto", argStr(args, "path")]),
  );

  // axotest_predict — uses axovb model to predict version bumps during test runs
  tb.register(
    "axotest_predict",
    "Predict semantic version bump from git diff (via axovb model).",
    { path: S("Path to git repo (relative to workspace)") },
    ["path"],
    (args) => runQaTool("axovb", ["predict", argStr(args, "path")]),
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