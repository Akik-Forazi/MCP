/**
 * Fix endpoints — verify, shadow, and the append-only fix queue.
 *
 * fix_shadow is the safe half of the axoniz shadow loop, implemented locally:
 * it creates a detached git worktree of the workspace at HEAD, applies the
 * candidate file writes THERE, runs the test command THERE, and removes the
 * worktree no matter what. The real workspace is never touched.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { resolveWithin } from "../core/guard.ts";
import { configPath, mcpHome, type GatewayConfig } from "./config.ts";

const run = promisify(execFile);

const TAIL_BYTES = 2000;

function tail(text: string, bytes = TAIL_BYTES): string {
  return text.length <= bytes ? text : `…\n${text.slice(-bytes)}`;
}

export async function runVerify(
  config: GatewayConfig,
  workspace: string,
  name?: string,
): Promise<string> {
  const commands = config.verify ?? [];
  if (commands.length === 0) {
    return `[ERROR] no verify commands configured — add a "verify" array (top level or under "mcp") to ${configPath()}`;
  }
  const selected = name ? commands.filter((c) => c.name === name) : commands;
  if (selected.length === 0) {
    return `[ERROR] no verify command named '${name}' (have: ${commands.map((c) => c.name).join(", ")})`;
  }
  const lines: string[] = [];
  let failed = 0;
  for (const command of selected) {
    const started = Date.now();
    try {
      const { stdout, stderr } = await run(command.cmd, command.args ?? [], {
        cwd: workspace,
        timeout: 300_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      const output = `${stdout}\n${stderr}`.trim();
      lines.push(`[PASS] ${command.name} (${String(Date.now() - started)}ms)`);
      if (output) lines.push(tail(output));
    } catch (err) {
      failed += 1;
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
      lines.push(`[FAIL] ${command.name} (exit ${String(e.code ?? "?")}${e.killed ? ", timed out" : ""})`);
      const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
      if (output) lines.push(tail(output));
      else if (e.message) lines.push(tail(e.message, 400));
    }
  }
  lines.push(`verify: ${String(selected.length - failed)}/${String(selected.length)} passed`);
  return lines.join("\n");
}

export interface ShadowFile {
  path: string;
  content: string;
}

export async function runShadow(
  workspace: string,
  files: ShadowFile[],
  testCmd: string,
): Promise<string> {
  if (files.length === 0) return "[ERROR] fix_shadow: 'files' must list at least one {path, content}";
  if (!testCmd.trim()) return "[ERROR] fix_shadow: 'test_cmd' is required";

  try {
    await run("git", ["rev-parse", "--git-dir"], { cwd: workspace, timeout: 20_000, windowsHide: true });
  } catch {
    return "[ERROR] fix_shadow: workspace is not a git repository (shadow needs a HEAD to branch from)";
  }

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-shadow-"));
  fs.rmSync(worktree, { recursive: true, force: true });
  const cleanup = async (): Promise<void> => {
    try {
      await run("git", ["worktree", "remove", "--force", worktree], { cwd: workspace, timeout: 30_000, windowsHide: true });
    } catch {
      /* best effort */
    }
    fs.rmSync(worktree, { recursive: true, force: true });
  };

  try {
    await run("git", ["worktree", "add", "--detach", worktree, "HEAD"], {
      cwd: workspace,
      timeout: 60_000,
      windowsHide: true,
    });

    for (const file of files) {
      const target = resolveWithin(worktree, file.path, false);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content);
    }

    const started = Date.now();
    const shell = process.platform === "win32";
    // cmd.exe mangles quoted program invocations (`node -e "…"` always exits 0
    // through /c parsing), so on Windows the command is dropped into a .cmd
    // file inside the throwaway worktree and executed from there.
    const shellCmd = shell ? (process.env.ComSpec ?? "cmd.exe") : "sh";
    let shellArgs: string[];
    if (shell) {
      const scriptPath = path.join(worktree, ".fraziym-shadow-test.cmd");
      fs.writeFileSync(scriptPath, `@echo off\r\n${testCmd.replace(/\r?\n/g, "\r\n")}\r\n`);
      shellArgs = ["/d", "/s", "/c", scriptPath];
    } else {
      shellArgs = ["-c", testCmd];
    }
    try {
      const { stdout, stderr } = await run(shellCmd, shellArgs, {
        cwd: worktree,
        timeout: 300_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      const output = `${stdout}\n${stderr}`.trim();
      return [
        `[SHADOW PASS] ${testCmd} (${String(Date.now() - started)}ms, ${String(files.length)} file(s) applied in throwaway worktree)`,
        tail(output),
      ]
        .filter(Boolean)
        .join("\n");
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
      const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
      return [
        `[SHADOW FAIL] ${testCmd} (exit ${String(e.code ?? "?")}${e.killed ? ", timed out" : ""}, workspace untouched)`,
        output ? tail(output) : tail(e.message ?? "", 400),
      ].join("\n");
    }
  } finally {
    await cleanup();
  }
}

interface QueueEntry {
  id: string;
  created: string;
  title: string;
  test_cmd?: string;
  files?: string[];
}

interface QueueEvent {
  type: "pull" | "complete";
  id: string;
  at: string;
  ok?: boolean;
  note?: string;
}

export function queuePath(home = mcpHome()): string {
  return path.join(home, "fix-queue.jsonl");
}

function readQueue(file: string): { entries: QueueEntry[]; events: QueueEvent[] } {
  const entries: QueueEntry[] = [];
  const events: QueueEvent[] = [];
  if (!fs.existsSync(file)) return { entries, events };
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<QueueEntry> & Partial<QueueEvent>;
      if (parsed.type === "pull" || parsed.type === "complete") {
        if (typeof parsed.id === "string") events.push(parsed as QueueEvent);
      } else if (typeof parsed.id === "string" && typeof parsed.title === "string") {
        entries.push(parsed as QueueEntry);
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return { entries, events };
}

export function queuePull(home = mcpHome()): string {
  const file = queuePath(home);
  const { entries, events } = readQueue(file);
  if (entries.length === 0) {
    return `[EMPTY] no fix items in ${file}`;
  }
  const completed = new Set(events.filter((e) => e.type === "complete").map((e) => e.id));
  const pulled = new Set(events.filter((e) => e.type === "pull").map((e) => e.id));
  const next = entries.find((entry) => !completed.has(entry.id) && !pulled.has(entry.id));
  if (!next) {
    return `[EMPTY] ${String(entries.length)} item(s) queued, none pending (${String(completed.size)} complete, ${String(pulled.size)} pulled)`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ type: "pull", id: next.id, at: new Date().toISOString() })}\n`);
  return `[PULL] ${JSON.stringify(next)}`;
}

export function queueComplete(home: string, id: string, ok: boolean, note?: string): string {
  const file = queuePath(home);
  const { entries } = readQueue(file);
  if (!entries.some((entry) => entry.id === id)) {
    return `[ERROR] unknown fix id '${id}' (known: ${entries.map((e) => e.id).join(", ") || "none"})`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({ type: "complete", id, at: new Date().toISOString(), ok, ...(note ? { note } : {}) })}\n`,
  );
  return `[DONE] ${id} marked ${ok ? "complete" : "failed"}${note ? ` (${note})` : ""}`;
}
