/**
 * Build bin/fraziym-mcp.exe — a tiny launcher that execs the Node CLI.
 * Uses the C# compiler bundled with Windows (csc.exe); skips gracefully on
 * non-Windows or when csc is absent (the CLI still works through Node).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

if (process.platform !== "win32") {
  console.log("[build-exe] non-Windows — skipping launcher exe (CLI works via Node).");
  process.exit(0);
}

const windir = process.env.WINDIR ?? "C:\\Windows";
const candidates = [
  path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];
const csc = candidates.find((p) => fs.existsSync(p));
if (!csc) {
  console.log("[build-exe] csc.exe not found — skipping launcher exe (CLI works via Node).");
  process.exit(0);
}

fs.mkdirSync("bin", { recursive: true });
const out = path.resolve("bin", "fraziym-mcp.exe");
execFileSync(
  csc,
  ["/nologo", "/optimize+", "/target:exe", `/out:${out}`, path.resolve("scripts", "launcher.cs")],
  { stdio: "inherit" },
);
console.log(`[build-exe] built ${out}`);
