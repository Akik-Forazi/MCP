/**
 * `fraziym-mcp doctor` — environment readiness checks.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { fraziymHome } from "../core/home.ts";

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

  const { axodexInvocation } = await import("../tools/axodex.ts");
  const inv = axodexInvocation();
  checks.push({
    name: "axodex cli",
    ok: inv !== null,
    detail: inv ? `resolved via ${inv.via}` : "not found — npm install -g @fraziym/axodex",
  });

  const axonizHome = process.env.AXONIZ_HOME?.trim() || path.join(fraziymHome(), "axoniz");
  try {
    fs.mkdirSync(axonizHome, { recursive: true });
    fs.accessSync(axonizHome, fs.constants.W_OK);
    checks.push({ name: "axoniz home", ok: true, detail: axonizHome });
  } catch {
    checks.push({ name: "axoniz home", ok: false, detail: `not writable: ${axonizHome}` });
  }

  try {
    const { LazyToolHost } = await import("../core/host.ts");
    const ax = new LazyToolHost({ group: "axoniz", workspace: process.cwd() });
    checks.push({
      name: "axoniz group",
      ok: ax.names().length === 72,
      detail: `${String(ax.names().length)} tools (catalog)`,
    });
    const xv = new LazyToolHost({ group: "xorvoid", workspace: process.cwd() });
    checks.push({
      name: "xorvoid group",
      ok: xv.names().length === 25,
      detail: `${String(xv.names().length)} tools (catalog)`,
    });
    const all = new LazyToolHost({ group: "all", workspace: process.cwd() });
    checks.push({
      name: "all group",
      ok: all.names().length === 74,
      detail: `${String(all.names().length)} tools (catalog)`,
    });
  } catch (e) {
    checks.push({
      name: "catalog",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    process.stdout.write(`${c.ok ? "OK  " : "FAIL"} ${c.name.padEnd(14)} ${c.detail}\n`);
  }
  return allOk ? 0 : 1;
}
