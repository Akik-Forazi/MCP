/**
 * AXONIZ-ZERO — internal helpers shared by the `src/tools/*` ports.
 *
 * Private to `src/tools` (`_` prefix, not re-exported from `index.ts`). It
 * replaces the Python standard-library primitives the original modules used:
 *
 *   subprocess.run(capture_output=True) -> runCaptured   (promisified exec)
 *   subprocess.run([...])               -> execFileCaptured
 *   glob.glob(..., recursive=True)      -> expandGlob / globToRegExp
 *   difflib.unified_diff                -> unifiedDiff
 *   shutil.which                        -> resolveCommand (wraps core whichSync)
 */

import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { whichSync } from "./core/which.ts";

/* ── subprocess ───────────────────────────────────────────────────────────── */

export interface CapturedRun {
  /** Captured stdout (UTF-8 decoded, invalid bytes replaced). */
  stdout: string;
  /** Captured stderr (UTF-8 decoded, invalid bytes replaced). */
  stderr: string;
  /** Exit code; `null` when the process was killed by a signal. */
  code: number | null;
  /** True when the process was killed because the timeout elapsed. */
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Output ceiling in characters (default 16 MiB). */
  maxBuffer?: number;
}

/**
 * Run a command through the platform shell (`cmd.exe /c` on Windows,
 * `/bin/sh -c` elsewhere) with output captured as text.
 *
 * Never rejects: spawn failures, non-zero exits and timeouts all resolve with
 * a `CapturedRun`, mirroring `subprocess.run` inside a try/except.
 */
export function runCaptured(command: string, opts: RunOptions = {}): Promise<CapturedRun> {
  const timeout = opts.timeoutMs ?? 0;
  return new Promise<CapturedRun>((resolve) => {
    exec(
      command,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: timeout > 0 ? timeout : undefined,
        killSignal: "SIGKILL",
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const e = err as
          | (Error & { code?: number | string; killed?: boolean; signal?: NodeJS.Signals })
          | null;
        let code: number | null = 0;
        let timedOut = false;
        if (e) {
          if (typeof e.code === "number") {
            code = e.code;
          } else if (e.killed || e.signal) {
            code = null;
            timedOut = true;
          } else {
            code = 1;
          }
        }
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code,
          timedOut,
        });
      },
    );
  });
}

/**
 * Run an executable directly (no shell) with output captured as text.
 * Rejects with the original error when the binary cannot be spawned at all
 * (Python's `FileNotFoundError`); non-zero exits and timeouts resolve.
 */
export function execFileCaptured(
  file: string,
  args: string[],
  opts: RunOptions = {},
): Promise<CapturedRun> {
  const timeout = opts.timeoutMs ?? 0;
  return new Promise<CapturedRun>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: timeout > 0 ? timeout : undefined,
        killSignal: "SIGKILL",
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        shell: false,
      },
      (err, stdout, stderr) => {
        const e = err as
          | (Error & { code?: number | string; killed?: boolean; signal?: NodeJS.Signals })
          | null;
        if (!e) {
          resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0, timedOut: false });
          return;
        }
        if (e.killed || e.signal) {
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            code: null,
            timedOut: true,
          });
          return;
        }
        if (typeof e.code === "number") {
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            code: e.code,
            timedOut: false,
          });
          return;
        }
        reject(e);
      },
    );
  });
}

/**
 * Resolve an executable against PATH, following Windows shim extensions
 * (`npx` -> `npx.cmd`) so `execFile` can launch it without a shell.
 */
export function resolveCommand(name: string): string | null {
  const direct = whichSync(name);
  if (direct) return direct;
  if (process.platform === "win32" && !/\.(cmd|bat|exe|com)$/i.test(name)) {
    return whichSync(`${name}.cmd`) ?? whichSync(`${name}.bat`) ?? whichSync(`${name}.exe`);
  }
  return null;
}

/** Render an unknown thrown value the way Python's `str(e)` would. */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/* ── glob (replaces the Python `glob` module; the npm package is unavailable) ── */

/** True when the segment contains glob metacharacters (`*`, `?`, `[...]`). */
export function hasGlobMagic(segment: string): boolean {
  return /[*?[]/.test(segment);
}

function escapeReChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Compile one `path`-style glob pattern into an anchored RegExp supporting
 * `*` (segment-local), `**` (any number of segments) and `[...]` classes.
 * Matching is done on forward-slash-normalised paths.
 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, "/");
  let out = "";
  let i = 0;
  while (i < p.length) {
    const ch = p[i]!;
    if (ch === "*") {
      let stars = 0;
      while (p[i] === "*") {
        stars++;
        i++;
      }
      if (stars >= 2) {
        if (p[i] === "/") {
          out += "(?:[^/]*/)*"; // `**/` => zero or more directories
          i++;
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (ch === "[") {
      const close = p.indexOf("]", i + 1);
      if (close > i + 1) {
        const inner = p.slice(i + 1, close);
        out += `[${inner.split("").map(escapeReChar).join("")}]`;
        i = close + 1;
        continue;
      }
      out += "\\[";
      i++;
      continue;
    }
    out += escapeReChar(ch);
    i++;
  }
  return new RegExp(`^${out}$`);
}

/**
 * `glob.glob(os.path.join(base, "**", pattern), recursive=True)`.
 *
 * Returns absolute paths built with the native separator, skipping
 * dot-directories (Python's `glob` does not descend into hidden entries for a
 * wildcard segment) and refusing to escape `base`.
 */
export function expandGlob(base: string, pattern: string): string[] {
  const results: string[] = [];
  const pat = pattern.replace(/\\/g, "/");
  const patWantsHidden = pat.startsWith(".") || pat.includes("/.");

  // A literal name (no magic, no separators) is resolved relative to base.
  if (!hasGlobMagic(pat) && !pat.includes("/")) {
    const candidate = path.join(base, pat);
    try {
      fs.statSync(candidate);
      results.push(candidate);
    } catch {
      /* not found */
    }
    return results;
  }

  const matchers = [globToRegExp(`**/${pat}`), globToRegExp(pat)];

  const walk = (dir: string, depth: number): void => {
    if (depth > 64) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        if (!patWantsHidden && name.startsWith(".")) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!patWantsHidden && name.startsWith(".")) continue;
      const rel = path.relative(base, full);
      if (rel.startsWith("..")) continue;
      const abs = full.replace(/\\/g, "/");
      const relSlash = rel.replace(/\\/g, "/");
      if (matchers.some((rx) => rx.test(abs) || rx.test(relSlash))) results.push(full);
    }
  };
  walk(path.resolve(base), 0);
  return results;
}

/* ── diff (replaces difflib.unified_diff) ─────────────────────────────────── */

export interface UnifiedDiffOptions {
  fromFile: string;
  toFile: string;
  /** Context lines, mirrors difflib's `n=`. Default 3. */
  context?: number;
}

/** One difflib-style opcode: a[i1:i2] vs b[j1:j2]. */
interface Opcode {
  tag: "equal" | "delete" | "insert";
  i1: number;
  i2: number;
  j1: number;
  j2: number;
}

/** Opcodes from an LCS table — same shape as `difflib.SequenceMatcher.get_opcodes()`. */
export function sequenceOpcodes(a: string[], b: string[]): Opcode[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nxt = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? nxt[j + 1]! + 1 : Math.max(nxt[j]!, row[j + 1]!);
    }
  }

  const ops: Opcode[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const startI = i;
    const startJ = j;
    if (a[i] === b[j]) {
      while (i < n && j < m && a[i] === b[j]) {
        i++;
        j++;
      }
      ops.push({ tag: "equal", i1: startI, i2: i, j1: startJ, j2: j });
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      while (i < n && j < m && a[i] !== b[j] && dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
      ops.push({ tag: "delete", i1: startI, i2: i, j1: startJ, j2: j });
    } else {
      while (i < n && j < m && a[i] !== b[j] && dp[i + 1]![j]! < dp[i]![j + 1]!) j++;
      ops.push({ tag: "insert", i1: startI, i2: i, j1: startJ, j2: j });
    }
  }
  if (i < n) ops.push({ tag: "delete", i1: i, i2: n, j1: j, j2: m });
  if (j < m) ops.push({ tag: "insert", i1: i, i2: n, j1: j, j2: m });
  return ops;
}

/**
 * Pragmatic stand-in for `difflib.unified_diff(a, b, fromfile, tofile, n=k)`.
 * Emits `---`/`+++` headers, `@@ -l,s +l,s @@` hunk headers, then context,
 * removal (`-`) and addition (`+`) lines exactly as difflib does.
 */
export function unifiedDiff(a: string[], b: string[], opts: UnifiedDiffOptions): string[] {
  const n = opts.context ?? 3;
  const out: string[] = [`--- ${opts.fromFile}`, `+++ ${opts.toFile}`];

  // Flatten to a tagged line stream.
  type Tag = "equal" | "delete" | "insert";
  interface Tagged {
    tag: Tag;
    text: string;
  }
  const tagged: Tagged[] = [];
  for (const op of sequenceOpcodes(a, b)) {
    if (op.tag === "equal") {
      for (let k = op.i1; k < op.i2; k++) tagged.push({ tag: "equal", text: a[k]! });
    } else if (op.tag === "delete") {
      for (let k = op.i1; k < op.i2; k++) tagged.push({ tag: "delete", text: a[k]! });
    } else {
      for (let k = op.j1; k < op.j2; k++) tagged.push({ tag: "insert", text: b[k]! });
    }
  }
  if (!tagged.some((t) => t.tag !== "equal")) return out;

  const changedIdx: number[] = [];
  tagged.forEach((t, i) => {
    if (t.tag !== "equal") changedIdx.push(i);
  });

  // Merge change windows that overlap within 2*n of context.
  const ranges: [number, number][] = [];
  let start = Math.max(0, changedIdx[0]! - n);
  let end = Math.min(tagged.length, changedIdx[0]! + n + 1);
  for (let k = 1; k < changedIdx.length; k++) {
    const i = changedIdx[k]!;
    if (i - n <= end) {
      end = Math.min(tagged.length, i + n + 1);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, i - n);
      end = Math.min(tagged.length, i + n + 1);
    }
  }
  ranges.push([start, end]);

  // Track 1-based line numbers on both sides across the whole stream.
  const aNo: number[] = new Array<number>(tagged.length + 1);
  const bNo: number[] = new Array<number>(tagged.length + 1);
  let aLine = 1;
  let bLine = 1;
  for (let i = 0; i < tagged.length; i++) {
    aNo[i] = aLine;
    bNo[i] = bLine;
    const t = tagged[i]!;
    if (t.tag !== "insert") aLine++;
    if (t.tag !== "delete") bLine++;
  }
  aNo[tagged.length] = aLine;
  bNo[tagged.length] = bLine;

  for (const [s, e] of ranges) {
    let aLen = 0;
    let bLen = 0;
    for (let k = s; k < e; k++) {
      const t = tagged[k]!;
      if (t.tag !== "insert") aLen++;
      if (t.tag !== "delete") bLen++;
    }
    const aStart = aLen === 0 ? aNo[s]! - 1 : aNo[s]!;
    const bStart = bLen === 0 ? bNo[s]! - 1 : bNo[s]!;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (let k = s; k < e; k++) {
      const t = tagged[k]!;
      const prefix = t.tag === "equal" ? " " : t.tag === "delete" ? "-" : "+";
      out.push(`${prefix}${t.text}`);
    }
  }
  return out;
}
