/**
 * `fraziym-mcp bench` — reproducible startup / listing / memory benchmark.
 *
 * Measures the same three things for this server and (optionally) a set of
 * competitor MCP servers fetched via npx:
 *
 *   readyMs   spawn → initialize result (cold start, lazy catalog)
 *   listMs    tools/list latency after handshake
 *   tools     tool count from tools/list
 *   rssMb     child-process working set after tools/list
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { findOnPath, isWindows, parseCmdShim } from "../core/exec.ts";

export interface BenchOptions {
  workspace: string;
  runs: number;
  json: boolean;
  competitors: boolean;
}

interface Sample {
  name: string;
  via: string;
  readyMs: number;
  listMs: number;
  tools: number;
  rssMb: number | null;
}

interface Failure {
  name: string;
  via: string;
  error: string;
}

type Result = Sample | Failure;

const TIMEOUT_MS = 90_000;

function isFailure(r: Result): r is Failure {
  return (r as Failure).error !== undefined;
}

function npxInvocation(): { cmd: string; base: string[] } | null {
  const bin = findOnPath("npx");
  if (!bin) return null;
  if (isWindows && /\.(cmd|bat)$/i.test(bin)) {
    const shim = parseCmdShim(bin);
    if (shim) return { cmd: shim.node, base: [shim.script] };
  }
  return { cmd: bin, base: [] };
}

function rssMbOf(pid: number): number | null {
  try {
    if (isWindows) {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      const m = out.match(/"([\d.,]+) K"/);
      if (!m?.[1]) return null;
      return Math.round((Number(m[1].replace(/[.,]/g, "")) / 1024) * 10) / 10;
    }
    const rss = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
    const kb = Number.parseInt(rss.trim(), 10);
    return Number.isNaN(kb) ? null : Math.round((kb / 1024) * 10) / 10;
  } catch {
    return null;
  }
}

function measure(cmd: string, args: string[], name: string, via: string, cwd: string): Promise<Result> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let buffer = "";
    let readyMs = 0;
    let settled = false;

    const finish = (r: Result): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(r);
    };

    const timer = setTimeout(
      () => finish({ name, via, error: `timed out after ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS,
    );

    child.on("error", (e) => finish({ name, via, error: `spawn failed: ${e.message}` }));

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line) continue;
        let msg: { id?: unknown; result?: { tools?: unknown[] }; error?: { message?: string } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error) {
            finish({ name, via, error: `initialize error: ${msg.error.message ?? "unknown"}` });
            return;
          }
          readyMs = Date.now() - t0;
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
          );
        } else if (msg.id === 2 && readyMs > 0) {
          const listMs = Date.now() - t0 - readyMs;
          const tools = Array.isArray(msg.result?.tools) ? msg.result.tools.length : 0;
          const rssPid = via === "exe" ? nodeChildOf(child.pid ?? 0) : (child.pid ?? 0);
          const rssMb = rssPid === null ? null : rssMbOf(rssPid);
          finish({ name, via, readyMs, listMs, tools, rssMb });
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "fraziym-mcp-bench", version: "1.0.0" },
        },
      })}\n`,
    );
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

async function measureRepeated(
  cmd: string,
  args: string[],
  name: string,
  via: string,
  cwd: string,
  runs: number,
  warmup = 0,
): Promise<Result> {
  for (let i = 0; i < warmup; i++) {
    const w = await measure(cmd, args, name, via, cwd);
    if (isFailure(w)) return w;
  }
  const samples: Sample[] = [];
  for (let i = 0; i < runs; i++) {
    const r = await measure(cmd, args, name, via, cwd);
    if (isFailure(r)) return r;
    samples.push(r);
  }
  return {
    name,
    via,
    readyMs: median(samples.map((s) => s.readyMs)),
    listMs: median(samples.map((s) => s.listMs)),
    tools: samples[0]?.tools ?? 0,
    rssMb: samples.map((s) => s.rssMb).filter((v): v is number => v !== null).sort((a, b) => a - b)[0] ?? null,
  };
}

function nodeChildOf(pid: number): number | null {
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.Name -eq 'node.exe' } | Select-Object -First 1 -ExpandProperty ProcessId)`,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    const id = Number.parseInt(out.trim(), 10);
    return Number.isNaN(id) ? null : id;
  } catch {
    return null;
  }
}

function selfInvocations(): Array<{ name: string; cmd: string; args: string[]; via: string }> {
  const out: Array<{ name: string; cmd: string; args: string[]; via: string }> = [];
  const distEntry = path.resolve("dist", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    out.push({ name: "fraziym-mcp (dist, published build)", cmd: process.execPath, args: [distEntry, "serve"], via: "dist" });
  }
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (entry && fs.existsSync(entry) && !entry.endsWith(`dist${path.sep}cli${path.sep}index.js`)) {
    out.push({
      name: "fraziym-mcp (source, type-strip)",
      cmd: process.execPath,
      args: [...process.execArgv, entry, "serve"],
      via: "source",
    });
  }
  const exe = path.resolve("bin", "fraziym-mcp.exe");
  if (isWindows && fs.existsSync(exe) && fs.existsSync(distEntry)) {
    out.push({ name: "fraziym-mcp.exe (launcher)", cmd: exe, args: ["serve"], via: "exe" });
  }
  return out;
}

function competitorInvocations(workspace: string): Array<{ name: string; cmd: string; args: string[]; via: string }> {
  const npx = npxInvocation();
  if (!npx) return [];
  const specs: Array<{ name: string; args: string[] }> = [
    {
      name: "@modelcontextprotocol/server-filesystem",
      args: ["--yes", "@modelcontextprotocol/server-filesystem", workspace],
    },
    { name: "@modelcontextprotocol/server-memory", args: ["--yes", "@modelcontextprotocol/server-memory"] },
    { name: "@modelcontextprotocol/server-everything", args: ["--yes", "@modelcontextprotocol/server-everything"] },
    {
      name: "@modelcontextprotocol/server-sequential-thinking",
      args: ["--yes", "@modelcontextprotocol/server-sequential-thinking"],
    },
  ];
  return specs.map((s) => ({ name: s.name, cmd: npx.cmd, args: [...npx.base, ...s.args], via: "npx" }));
}

function fmt(r: Result): string {
  if (isFailure(r)) return `${r.name.padEnd(42)} FAILED — ${r.error}`;
  const rss = r.rssMb === null ? "?" : `${r.rssMb} MB`;
  return (
    `${r.name.padEnd(42)} ready ${String(r.readyMs).padStart(5)}ms   ` +
    `tools/list ${String(r.listMs).padStart(4)}ms   ${String(r.tools).padStart(3)} tools   RSS ${rss}`
  );
}

export async function bench(opts: BenchOptions): Promise<number> {
  const runs = Math.max(1, opts.runs);
  const results: Result[] = [];

  for (const s of selfInvocations()) {
    results.push(await measureRepeated(s.cmd, s.args, s.name, s.via, opts.workspace, runs));
  }
  if (opts.competitors) {
    for (const c of competitorInvocations(opts.workspace)) {
      results.push(await measureRepeated(c.cmd, c.args, c.name, c.via, opts.workspace, runs, 1));
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ workspace: opts.workspace, runs, results }, null, 2)}\n`);
  } else {
    process.stdout.write(`fraziym-mcp bench — ${String(runs)} run(s), median\n\n`);
    for (const r of results) process.stdout.write(`${fmt(r)}\n`);
    process.stdout.write(
      "\nready = spawn → initialize result · listMs = tools/list round-trip · RSS = working set after tools/list\n",
    );
  }

  return results.some((r) => r.name.startsWith("fraziym-mcp") && isFailure(r)) ? 1 : 0;
}
