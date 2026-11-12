/**
 * AXONIZ ShellTools — Windows-aware shell execution (TypeScript port).
 *
 * Ported from `axoniz/tools/shell_tools.py`. Keeps: unix→windows command
 * translation, output truncation limits, env injection, timeout handling and
 * background process launch.
 *
 * Python-stdlib mapping:
 *   subprocess.run(shell=True, capture_output=True, timeout=…) -> runCaptured
 *   subprocess.Popen(DEVNULL, CREATE_NO_WINDOW)                -> spawn + detached
 *   shutil.which                                               -> core whichSync
 *   exec(compile(code))                                        -> a real Python
 *     interpreter via `python -c`. This is a Node process, so there is no
 *     in-process Python VM; the capability degrades gracefully with a clear
 *     string when no interpreter is installed.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { whichSync } from "./core/which.ts";
import { errText, execFileCaptured, runCaptured } from "./_internal.ts";

const IS_WINDOWS = process.platform === "win32";
const MAX_OUTPUT = 8000; // chars, to avoid context overflow

const _UNIX_TO_WIN: Record<string, string> = {
  ls: "dir /b",
  cat: "type",
  rm: "del",
  cp: "copy",
  mv: "move",
  grep: "findstr",
  touch: "echo.>",
  clear: "cls",
  pwd: "cd",
  which: "where",
  echo: "echo",
};

export class ShellTools {
  readonly workspace: string;

  constructor(workspace = ".") {
    this.workspace = path.resolve(workspace);
  }

  /** Run a shell command. Windows-aware, auto-translates unix basics. */
  async run(command: string, timeout = 60, env?: Record<string, string> | null): Promise<string> {
    let cmd = command.trim();
    if (!cmd) return "[ERROR] Empty command";

    if (IS_WINDOWS) {
      const first = (cmd.split(/\s+/)[0] ?? "").toLowerCase();
      let note = "";
      if (Object.prototype.hasOwnProperty.call(_UNIX_TO_WIN, first)) {
        const win = _UNIX_TO_WIN[first]!;
        // Python's `str.replace(first, win, 1)`: replaces the first occurrence.
        cmd = cmd.replace(first, win);
        note = `[auto] '${first}' → '${win}'\n`;
      }
      const result = await this._runRaw(cmd, timeout, env);
      return note ? note + result : result;
    }

    return this._runRaw(cmd, timeout, env);
  }

  async _runRaw(
    command: string,
    timeout = 60,
    env?: Record<string, string> | null,
  ): Promise<string> {
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env };
    if (env) Object.assign(mergedEnv, env);
    try {
      const res = await runCaptured(command, {
        cwd: this.workspace,
        env: mergedEnv,
        timeoutMs: Math.max(0, timeout) * 1000,
      });
      if (res.timedOut) return `[TIMEOUT] Command killed after ${timeout}s: ${command}`;

      let out = res.stdout.trim();
      let err = res.stderr.trim();
      const code = res.code ?? 0;

      if (out.length > MAX_OUTPUT) {
        // Python re-reads `len(out)` after the slice for the reported total.
        out = out.slice(0, MAX_OUTPUT);
        out = `${out}\n… [truncated, ${out.length} total chars]`;
      }
      if (err.length > 2000) {
        err = `${err.slice(0, 2000)}… [truncated]`;
      }

      const parts = [`$ ${command}  [exit ${code}]`];
      if (out) parts.push(out);
      if (err) parts.push(`stderr: ${err}`);
      if (!out && !err) parts.push("(no output)");
      return parts.join("\n");
    } catch (e) {
      return `[ERROR] Shell: ${errText(e)}`;
    }
  }

  /** Start a background process (non-blocking). Returns PID. */
  runBg(command: string): string {
    try {
      const child = spawn(command, {
        shell: true,
        cwd: this.workspace,
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.unref();
      return `[OK] Background process started  pid=${child.pid}  cmd=${command}`;
    } catch (e) {
      return `[ERROR] Background process failed: ${errText(e)}`;
    }
  }

  /**
   * Execute Python inline, capture output.
   *
   * NOTE: the Python original used in-process `exec()`. A Node process has no
   * Python VM, so the code is handed to an interpreter found on PATH
   * (`python`, then `python3`); if none exists a clear `[PYTHON ERROR]` string
   * is returned rather than throwing.
   */
  async runPython(code: string): Promise<string> {
    const python = whichSync("python") ?? whichSync("python3");
    if (!python) {
      return (
        "[PYTHON ERROR]\n" +
        "The 'python' interpreter was not found on PATH. Inline Python execution " +
        "requires a Python installation (the Python original ran the code in-process)."
      );
    }
    try {
      const res = await execFileCaptured(python, ["-c", code], {
        cwd: this.workspace,
        timeoutMs: 60_000,
      });
      const out = res.stdout;
      const err = res.stderr;
      const parts = [`python (${code.length} chars)`];
      if (out) parts.push(out.slice(0, MAX_OUTPUT));
      if (err) parts.push(`stderr:\n${err.slice(0, 2000)}`);
      if (!out && !err) parts.push("(no output)");
      return parts.join("\n");
    } catch (e) {
      return `[PYTHON ERROR]\n${errText(e).slice(0, 3000)}`;
    }
  }

  /** Check if a program is available in PATH. */
  which(name: string): string {
    const p = whichSync(name);
    return p ? `[OK] ${name} → ${p}` : `[NOT FOUND] ${name} not in PATH`;
  }

  /** Return useful environment info. */
  envInfo(): string {
    const pathEntries = (process.env.PATH ?? "").split(path.delimiter).length;
    return (
      `Node ${process.version}\n` +
      `OS: ${os.type()} ${os.release()}\n` +
      `CWD: ${this.workspace}\n` +
      `PATH entries: ${pathEntries}`
    );
  }
}
