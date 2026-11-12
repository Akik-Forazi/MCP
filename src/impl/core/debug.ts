/**
 * Minimal local logger for vendored tool implementations.
 *
 * Replaces axoniz's src/core/logger.ts re-export shim. The moved tools only
 * need `error` and `info`; pulling in axoniz's full logger (LogConfig,
 * AxonizLogger, robustHandle, file sinks) would re-couple mcp to axoniz core.
 *
 * Honours AXONIZ_DEBUG / DEBUG for verbosity, writes to stderr so it never
 * corrupts the MCP stdio protocol on stdout.
 */

const DEBUG_ON =
  !!process.env.AXONIZ_DEBUG || !!process.env.FRAZIYM_DEBUG || !!process.env.DEBUG;

function emit(level: string, args: unknown[]): void {
  const msg = args
    .map((a) => (typeof a === "string" ? a : safeJson(a)))
    .join(" ");
  process.stderr.write(`[${level}] ${msg}\n`);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function error(...args: unknown[]): void {
  emit("error", args);
}

export function warn(...args: unknown[]): void {
  emit("warn", args);
}

export function info(...args: unknown[]): void {
  if (DEBUG_ON) emit("info", args);
}

export function debug(...args: unknown[]): void {
  if (DEBUG_ON) emit("debug", args);
}
