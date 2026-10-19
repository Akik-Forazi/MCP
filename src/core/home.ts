/**
 * Fraziym home layout — ONE root for every Fraziym product:
 *
 *   ~/.fraziym/                  (override: $FRAZIYM_HOME)
 *   ├── config.json              shared env config (all products)
 *   ├── axoniz/                  (other products follow the same shape)
 *   └── axodex/
 *
 * Machine-local state that never roams (audit log, fix queue) lives under the
 * FRAZIYM cache root instead (T2 — `%LOCALAPPDATA%\FRAZIYM` on Windows,
 * `~/Library/Caches/FRAZIYM` on macOS, `$XDG_CACHE_HOME/fraziym` on Linux;
 * override `$FRAZIYM_LOCAL`).
 *
 * `mcpHome()` honors the explicit $FRAZIYM_MCP_HOME override first (full path
 * to the state dir), then nests under the machine-local cache root.
 */

import os from "node:os";
import path from "node:path";

/** Shared Fraziym root (~/.fraziym, or $FRAZIYM_HOME). */
export function fraziymHome(): string {
  const home = process.env.FRAZIYM_HOME?.trim();
  return home ? path.resolve(home) : path.join(os.homedir(), ".fraziym");
}

/** Machine-local Fraziym cache root (T2 — caches and state that never roams). */
export function fraziymLocal(): string {
  const override = process.env.FRAZIYM_LOCAL?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "FRAZIYM");
  }
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "FRAZIYM");
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  return path.join(xdg || path.join(os.homedir(), ".cache"), "fraziym");
}

/** Per-product state dir for @fraziym/mcp (audit + fix queue) — machine-local, or $FRAZIYM_MCP_HOME. */
export function mcpHome(): string {
  const home = process.env.FRAZIYM_MCP_HOME?.trim();
  return home ? path.resolve(home) : path.join(fraziymLocal(), "mcp");
}
