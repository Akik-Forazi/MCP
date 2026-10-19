/**
 * Guard — the enforcement layer between raw LLM arguments and tool handlers.
 *
 * Everything a tool call touches passes through here first:
 *   1. Workspace jail  — path-like args are canonicalized (realpath, symlink-
 *      resolved) and must stay inside the workspace root. Kills the
 *      CVE-2025-53109/53110 class (naive prefix checks, symlink escapes).
 *   2. Argument validation — required keys, type coercion, per-arg cap
 *      (2 MiB default) and a hard 4 KB cap on filesystem-path arguments.
 *   3. Output truncation — 64 KB default, marked when cut.
 *   4. Timeout + audit — every call is time-bounded and (optionally) logged
 *      to the machine-local FRAZIYM cache (`%LOCALAPPDATA%\FRAZIYM\mcp\audit.jsonl`)
 *      with secrets scrubbed.
 *
 * The layer wraps handlers, so a guarded Toolbox behaves exactly like the
 * original one — except escapes become `[ERROR] ... escapes workspace`.
 */

import fs from "node:fs";
import path from "node:path";

import { appendAudit, hashArgs, redactPreview } from "./audit.ts";
import { isWindows } from "./exec.ts";
import { PATH_ARG_MAX, PATH_ARGS } from "./path-args.ts";
import { Toolbox } from "./toolbox.ts";
import type { ToolFunctionSchema, ToolHandler } from "./types.ts";

export class WorkspaceViolationError extends Error {
  constructor(requested: string, root: string) {
    super(`path escapes workspace: "${requested}" (workspace: ${root})`);
    this.name = "WorkspaceViolationError";
  }
}

/** Tool name → argument keys that hold filesystem paths. */
export { PATH_ARG_MAX, PATH_ARGS } from "./path-args.ts";

const DEVICE_BASENAME = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const DEVICE_NAMESPACE = /^\\\\\.\\/;

/** Strip the Windows extended-length prefix so comparisons see plain paths. */
function plain(p: string): string {
  return p.startsWith("\\\\?\\") ? p.slice(4) : p;
}

/** Realpath the deepest existing ancestor, then re-append the missing tail. */
function canonicalize(full: string): string {
  let cur = full;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = plain(fs.realpathSync.native(cur));
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return path.normalize(full);
      const parent = path.dirname(cur);
      if (parent === cur) return path.normalize(full);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `rel` (path.relative(root, child)) stays inside the root. */
function contained(rel: string): boolean {
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

/**
 * Resolve `p` against `root` and enforce containment.
 * Returns the canonical absolute path (rewriting is output-compatible:
 * axoniz tools display workspace-relative labels either way).
 */
export function resolveWithin(root: string, p: string, allowOutside = false): string {
  if (typeof p !== "string" || p.length === 0) p = ".";
  if (p.includes("\0")) throw new WorkspaceViolationError(p, root);

  const rootReal = canonicalize(path.resolve(root));
  const full = path.isAbsolute(p) ? path.normalize(p) : path.resolve(rootReal, p);

  if (isWindows) {
    if (DEVICE_NAMESPACE.test(full)) throw new WorkspaceViolationError(p, root);
    const segs = full.split(/[\\/]+/).filter((s) => s !== "" && !/^[A-Za-z]:$/.test(s));
    for (const seg of segs) {
      if (/[ .]$/.test(seg)) throw new WorkspaceViolationError(p, root);
      if (DEVICE_BASENAME.test(seg)) throw new WorkspaceViolationError(p, root);
    }
  }

  const canon = canonicalize(full);
  if (!allowOutside && !contained(path.relative(rootReal, canon))) {
    throw new WorkspaceViolationError(p, root);
  }
  return canon;
}

export interface GuardOptions {
  /** Workspace root everything is confined to. */
  root: string;
  /** Permit paths outside the root (explicit opt-out). Default false. */
  allowOutside?: boolean;
  /** Per-string-argument character cap. Default 2 MiB. */
  maxArgLength?: number;
  /** Output byte cap before truncation. Default 65536. */
  maxOutputBytes?: number;
  /** Per-call timeout. Default 300000 (unified memory compaction can be slow). */
  timeoutMs?: number;
  /** Write JSONL audit records. true → default path, string → file path. */
  audit?: boolean | string;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Validate + jail arguments for one tool. Returns a rewritten arg object. */
export function validateToolArgs(
  name: string,
  spec: ToolFunctionSchema,
  args: Record<string, unknown>,
  opts: GuardOptions,
): Record<string, unknown> {
  const maxLen = opts.maxArgLength ?? 2 * 1024 * 1024;
  const props = spec.function.parameters.properties ?? {};
  const out: Record<string, unknown> = { ...args };

  for (const key of spec.function.parameters.required ?? []) {
    const v = out[key];
    if (v === undefined || v === null) {
      throw new Error(`missing required argument "${key}"`);
    }
  }

  for (const [key, prop] of Object.entries(props)) {
    const v = out[key];
    if (v === undefined || v === null) continue;
    const declared = prop.type;
    if (declared === "string" || typeof v === "string") {
      const s = String(v);
      if (s.length > maxLen) {
        throw new Error(`argument "${key}" exceeds ${maxLen} characters`);
      }
      out[key] = s;
    } else if (declared === "integer" || declared === "number") {
      if (!Number.isFinite(Number(v))) {
        throw new Error(`argument "${key}" must be a number`);
      }
    }
  }

  for (const key of PATH_ARGS[name] ?? []) {
    const v = out[key];
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (s.length > PATH_ARG_MAX) {
      throw new Error(`argument "${key}" exceeds ${PATH_ARG_MAX} characters (path arguments are capped)`);
    }
    out[key] = resolveWithin(opts.root, s, opts.allowOutside ?? false);
  }

  return out;
}

/** Cap output at `maxBytes`, appending a marker that says how much was cut. */
export function truncateOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return { text, truncated: false };
  const removed = buf.byteLength - maxBytes;
  const head = buf.subarray(0, maxBytes).toString("utf8");
  return { text: `${head}\n…[truncated ${removed} bytes]`, truncated: true };
}

function withTimeout<T>(p: Promise<T> | T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Wrap every handler of `tb` with the guard layer. Meta (destructive/network)
 * and schemas pass through untouched, so subset/merge/serve gates keep working.
 */
export function guardToolbox(tb: Toolbox, opts: GuardOptions): Toolbox {
  const out = new Toolbox();
  const auditOn = opts.audit !== undefined && opts.audit !== false;
  const auditTarget = typeof opts.audit === "string" ? opts.audit : undefined;

  for (const entry of tb.list()) {
    const spec = entry.schema;
    const name = spec.function.name;
    const handler: ToolHandler = async (rawArgs) => {
      const started = Date.now();
      let result: string;
      let status: "ok" | "error" | "truncated" | "timeout" = "ok";
      try {
        const args = validateToolArgs(name, spec, rawArgs ?? {}, opts);
        const res = await withTimeout(
          Promise.resolve(entry.handler(args)),
          opts.timeoutMs ?? 300000,
        );
        result = typeof res === "string" ? res : String(res);
        if (result.startsWith("[ERROR]")) status = "error";
      } catch (e) {
        result = `[ERROR] ${name}: ${errText(e)}`;
        status = /timed out after/.test(errText(e)) ? "timeout" : "error";
      }

      const capped = truncateOutput(result, opts.maxOutputBytes ?? 65536);
      if (capped.truncated && status === "ok") status = "truncated";

      if (auditOn) {
        appendAudit(
          {
            ts: new Date().toISOString(),
            tool: name,
            argsHash: hashArgs(rawArgs ?? {}),
            argsPreview: redactPreview(rawArgs ?? {}),
            ms: Date.now() - started,
            status,
          },
          auditTarget,
        );
      }
      return capped.text;
    };
    out.registerSpec(spec, handler, entry.meta);
  }
  return out;
}
