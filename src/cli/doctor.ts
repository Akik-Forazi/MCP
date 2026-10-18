/**
 * `fraziym-mcp doctor` — environment readiness checks.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { toolboxFor } from "./util.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function runQuiet(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return undefined;
  }
}

export async function doctor(): Promise<number> {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split(".")[0] ?? 0);
  checks.push({
    name: "node",
    ok: major >= 24,
    detail: `v${process.versions.node} (need >=24)`,
  });

  const git = runQuiet("git", ["--version"]);
  checks.push({ name: "git", ok: git !== undefined, detail: git ?? "not found on PATH" });

  const axodex = runQuiet("axodex", ["--help"]);
  checks.push({
    name: "axodex cli",
    ok: true,
    detail: axodex !== undefined ? "on PATH" : "not on PATH (axoniz falls back to global npm)",
  });

  const axonizHome = path.join(os.homedir(), ".axoniz");
  try {
    fs.mkdirSync(axonizHome, { recursive: true });
    fs.accessSync(axonizHome, fs.constants.W_OK);
    checks.push({ name: "axoniz home", ok: true, detail: axonizHome });
  } catch {
    checks.push({ name: "axoniz home", ok: false, detail: `not writable: ${axonizHome}` });
  }

  try {
    const tb = toolboxFor("axoniz", process.cwd());
    checks.push({ name: "axoniz group", ok: tb.names().length === 72, detail: `${String(tb.names().length)} tools` });
  } catch (e) {
    checks.push({ name: "axoniz group", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  try {
    const tb = toolboxFor("xorvoid", process.cwd());
    checks.push({ name: "xorvoid group", ok: tb.names().length === 25, detail: `${String(tb.names().length)} tools` });
  } catch (e) {
    checks.push({ name: "xorvoid group", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    process.stdout.write(`${c.ok ? "OK  " : "FAIL"} ${c.name.padEnd(14)} ${c.detail}\n`);
  }
  return allOk ? 0 : 1;
}
