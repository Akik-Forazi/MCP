/**
 * `fraziym-mcp fuzz` — deterministic adversarial pack against the workspace
 * jail. Throws the known CVE-shaped traversal pack (53109/53110 class), Windows
 * device names, UNC/device-namespace paths, absurd lengths and 300 seeded
 * random paths at `resolveWithin` / `validateToolArgs`, then asserts nothing
 * escapes the root. Writes fuzz-report.json; exits 1 on any breach.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveWithin, validateToolArgs } from "../core/guard.ts";
import type { ToolFunctionSchema } from "../core/types.ts";

export interface FuzzOptions {
  out: string;
  cases: number;
  seed: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPath(rand: () => number, root: string): string {
  const atoms = [
    "..",
    ".",
    "/",
    "\\",
    "",
    "a",
    "b",
    "dir",
    "space ",
    ":",
    "$",
    "%2e%2e",
    "%5c",
    "..\\",
    "../",
    "....//",
    "CON",
    "NUL.txt",
    "COM1",
    "LPT9",
    "file.txt",
    ".",
    "..",
    "\0",
    root,
    path.sep,
  ];
  const n = 2 + Math.floor(rand() * 6);
  let s = "";
  for (let i = 0; i < n; i++) s += atoms[Math.floor(rand() * atoms.length)] ?? "";
  return s;
}

const PATH_SPEC: ToolFunctionSchema = {
  type: "function",
  function: {
    name: "file_read",
    description: "",
    parameters: { type: "object", properties: { path: { type: "string", maxLength: 4096 } }, required: ["path"] },
  },
};

export async function fuzz(opts: FuzzOptions): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-fuzz-"));
  const inside = path.join(root, "inside.txt");
  fs.writeFileSync(inside, "fuzz");
  const base = fs.realpathSync.native(root);

  const attacks: string[] = [
    "../inside.txt",
    "..\\inside.txt",
    "a/../../inside.txt",
    "a/..\\..\\inside.txt",
    path.join(root, "..", "inside.txt"),
    `${root}-evil/x`,
    "....//....//inside.txt",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "\\\\server\\share\\x",
    "\\\\?\\C:\\Windows\\win.ini",
    "\\\\.\\C:\\Windows\\win.ini",
    "CON",
    "con.txt",
    "NUL.txt",
    "COM1",
    "LPT9.log",
    "a\0b",
    "a".repeat(5000),
    "..%2finside.txt",
    "..%5cinside.txt",
    "%2e%2e%2finside.txt",
    "....\\....\\inside.txt",
    ".. /inside.txt",
    "..\\  /inside.txt",
    "./../inside.txt",
    "inside.txt/../../inside.txt",
  ];

  const rand = mulberry32(opts.seed);
  const randomCases: string[] = [];
  for (let i = 0; i < opts.cases; i++) randomCases.push(randomPath(rand, root));

  const breaches: Array<{ input: string; result: string }> = [];
  let rejected = 0;
  let contained = 0;

  const checkPath = (input: string): void => {
    let result: string;
    try {
      result = resolveWithin(root, input, false);
    } catch {
      rejected += 1;
      return;
    }
    const normalized = result.replace(/[\\/]+$/, "").toLowerCase();
    const insideBase = normalized === base.toLowerCase() || normalized.startsWith(`${base.toLowerCase()}${path.sep}`);
    if (insideBase) contained += 1;
    else breaches.push({ input, result });
  };

  for (const attack of attacks) checkPath(attack);
  for (const randomCase of randomCases) checkPath(randomCase);

  const lengthChecks: Array<{ input: string; rejected: boolean }> = [];
  for (const probe of [
    { key: "path", value: "a".repeat(5000), note: "path-arg cap 4096" },
    { key: "path", value: "a".repeat(2 * 1024 * 1024 + 1), note: "global cap 2 MiB" },
  ]) {
    let ok = false;
    try {
      validateToolArgs("file_read", PATH_SPEC, { [probe.key]: probe.value }, { root });
    } catch {
      ok = true;
    }
    lengthChecks.push({ input: probe.note, rejected: ok });
    if (!ok) breaches.push({ input: probe.note, result: "oversized argument was accepted" });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    root,
    seed: opts.seed,
    cases: attacks.length + randomCases.length,
    rejected,
    contained,
    breaches,
    lengthChecks,
  };
  fs.writeFileSync(path.resolve(opts.out), `${JSON.stringify(report, null, 2)}\n`);
  fs.rmSync(root, { recursive: true, force: true });

  process.stdout.write(
    `fuzz: ${String(report.cases)} path cases (${String(attacks.length)} known + ${String(randomCases.length)} seeded) — ` +
      `${String(rejected)} rejected, ${String(contained)} contained, ${String(breaches.length)} breaches\n` +
      `fuzz: length checks — ${lengthChecks.map((c) => `${c.input}: ${c.rejected ? "rejected" : "ACCEPTED"}`).join("; ")}\n` +
      `report: ${path.resolve(opts.out)}\n`,
  );
  return breaches.length > 0 ? 1 : 0;
}
