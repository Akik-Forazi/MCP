/**
 * Audit log — one JSONL line per tool call, written outside the workspace.
 *
 * Never records raw arguments or outputs: secrets are scrubbed and values
 * previewed. The default location is `~/.fraziym/mcp/audit.jsonl`; override
 * with `FRAZIYM_MCP_AUDIT` (full file path) or `FRAZIYM_MCP_HOME` (dir).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { mcpHome } from "./home.ts";

export interface AuditEntry {
  ts: string;
  tool: string;
  argsHash: string;
  argsPreview: string;
  ms: number;
  status: "ok" | "error" | "truncated" | "timeout";
}

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|credential/i;
const SECRET_VALUE =
  /(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AIza[A-Za-z0-9_-]{10,}|xox[baprs]-[A-Za-z0-9-]{8,}|Bearer\s+\S+)/g;

export function auditFilePath(): string {
  const explicit = process.env.FRAZIYM_MCP_AUDIT;
  if (explicit && explicit.trim()) return path.resolve(explicit);
  return path.join(mcpHome(), "audit.jsonl");
}

export function hashArgs(args: Record<string, unknown>): string {
  let json = "";
  try {
    json = JSON.stringify(args) ?? "";
  } catch {
    json = String(args);
  }
  return crypto.createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/** Secret-scrubbed, length-capped one-line preview of the arguments. */
export function redactPreview(args: Record<string, unknown>, maxChars = 220): string {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (SECRET_KEY.test(k)) {
      safe[k] = "[redacted]";
      continue;
    }
    if (typeof v === "string") {
      let s = v.replace(SECRET_VALUE, "[redacted]");
      if (s.length > 120) s = `${s.slice(0, 117)}...`;
      safe[k] = s;
      continue;
    }
    safe[k] = v;
  }
  let out = "";
  try {
    out = JSON.stringify(safe) ?? "";
  } catch {
    out = "[unserializable]";
  }
  return out.length > maxChars ? `${out.slice(0, maxChars - 3)}...` : out;
}

const dirsEnsured = new Set<string>();

/** Fire-and-forget append. Swallows every error — auditing must never break a call. */
export function appendAudit(entry: AuditEntry, file = auditFilePath()): void {
  try {
    const dir = path.dirname(file);
    if (!dirsEnsured.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      dirsEnsured.add(dir);
    }
    fs.appendFile(file, `${JSON.stringify(entry)}\n`, () => {});
  } catch {
    /* never throw from the audit path */
  }
}
