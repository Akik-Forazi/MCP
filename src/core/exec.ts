/**
 * Shell-free process execution — the foundation of every command we run.
 *
 * Nothing in this module ever goes through `cmd.exe /c` or `/bin/sh -c`:
 * arguments are passed as real argv arrays, which kills the entire
 * argument-injection class (CVE-2025-68144 and friends) at the root.
 *
 * Windows caveat: `.cmd`/`.bat` shims (npm global bins) cannot be spawned
 * directly by Node. Instead of falling back to a shell, `parseCmdShim`
 * extracts the real `node script.js` invocation from the shim text.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const isWindows = process.platform === "win32";

export interface ExecResult {
  /** Exit code, or null when the process never spawned. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the child was killed because of the timeout. */
  timedOut: boolean;
  /** Spawn-level failure, e.g. "ENOENT" (binary not found) or "maxBuffer". */
  spawnError: string | null;
}

export interface ExecCaptureOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run `file` with `argv` and capture stdout/stderr. Never throws. */
export function execCapture(
  file: string,
  argv: readonly string[],
  opts: ExecCaptureOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...argv],
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        windowsHide: true,
        env: opts.env,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        let code: number | null = 0;
        let spawnError: string | null = null;
        let timedOut = false;

        if (error) {
          const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            spawnError = "maxBuffer";
            code = null;
          } else if (e.killed === true || e.signal === "SIGTERM" || e.signal === "SIGKILL") {
            timedOut = true;
            code = null;
          } else if (typeof e.code === "number") {
            code = e.code;
          } else if (typeof e.code === "string") {
            spawnError = e.code;
            code = null;
          } else {
            code = 1;
          }
        }

        resolve({
          code,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          timedOut,
          spawnError,
        });
      },
    );
  });
}

/** Find an executable on PATH without spawning a shell. */
export function findOnPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const names = isWindows
    ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
    : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const full = path.join(dir, n);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

export interface ShimInvocation {
  /** Node binary to spawn. */
  node: string;
  /** Absolute path of the JS entry the shim would run. */
  script: string;
}

/**
 * Extract `node <script.js>` from an npm `.cmd`/`.bat` shim. Handles both the
 * classic shape (`"%_prog%" "%dp0%\...\cli.js" %*`) and the modern npm 10+
 * shape that routes the script through `SET "NPX_CLI_JS=%~dp0\...\x.js"` +
 * `"%NODE_EXE%" "%NPX_CLI_JS%" %*`. Returns null when the shim has an
 * unexpected shape.
 */
export function parseCmdShim(shimPath: string): ShimInvocation | null {
  let text: string;
  try {
    text = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(shimPath);
  const expand = (value: string): string => value.replace(/%~?dp0%?/gi, dir);

  const vars = new Map<string, string[]>();
  for (const m of text.matchAll(/SET\s+"?([A-Za-z_][A-Za-z0-9_]*)=([^"\r\n]+)"?/gi)) {
    const name = (m[1] ?? "").toUpperCase();
    const value = m[2];
    if (!name || value === undefined) continue;
    const list = vars.get(name) ?? [];
    list.push(value);
    vars.set(name, list);
  }

  // Try every assignment of a variable (latest first, so runtime overrides
  // win) and every nested %OTHER% reference; return the first path that
  // actually exists, so helper scripts that never run are skipped.
  const resolveVar = (name: string, depth: number): string | null => {
    if (depth > 5) return null;
    const values = vars.get(name);
    if (!values) return null;
    for (let i = values.length - 1; i >= 0; i--) {
      const substituted = (values[i] ?? "").replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, ref: string) => {
        return resolveVar(String(ref).toUpperCase(), depth + 1) ?? whole;
      });
      const resolved = path.resolve(dir, expand(substituted));
      if (fs.existsSync(resolved)) return resolved;
    }
    return null;
  };

  const candidates: Array<{ index: number; script: string }> = [];
  for (const m of text.matchAll(/"(?:%~?dp0%|%~dp0)\\?([^"%]+?\.(?:js|cjs|mjs))"/gi)) {
    if (m[1] === undefined || m.index === undefined) continue;
    const script = path.resolve(dir, m[1]);
    if (fs.existsSync(script)) candidates.push({ index: m.index, script });
  }
  for (const m of text.matchAll(/"%([A-Za-z_][A-Za-z0-9_]*)%"/g)) {
    if (m.index === undefined) continue;
    const script = resolveVar((m[1] ?? "").toUpperCase(), 0);
    if (script && /\.(js|cjs|mjs)$/i.test(script)) candidates.push({ index: m.index, script });
  }
  if (candidates.length === 0) return null;

  // The script the shim actually executes is the last JS it references
  // (helper scripts like npm-prefix.js come earlier in the file).
  candidates.sort((a, b) => a.index - b.index);
  const chosen = candidates[candidates.length - 1];
  return chosen ? { node: process.execPath, script: chosen.script } : null;
}
