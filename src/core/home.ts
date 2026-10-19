/**
 * Fraziym home layout — ONE root for every Fraziym product:
 *
 *   ~/.fraziym/                  (override: $FRAZIYM_HOME)
 *   ├── config.json              shared env config (all products)
 *   ├── mcp/                     @fraziym/mcp state: audit.jsonl, fix-queue.jsonl
 *   ├── axoniz/                  (other products follow the same shape)
 *   └── axodex/
 *
 * `mcpHome()` honors the explicit $FRAZIYM_MCP_HOME override first (full path
 * to the state dir), then nests under the shared root.
 */

import os from "node:os";
import path from "node:path";

/** Shared Fraziym root (~/.fraziym, or $FRAZIYM_HOME). */
export function fraziymHome(): string {
  const home = process.env.FRAZIYM_HOME?.trim();
  return home ? path.resolve(home) : path.join(os.homedir(), ".fraziym");
}

/** Per-product state dir for @fraziym/mcp — ~/.fraziym/mcp, or $FRAZIYM_MCP_HOME. */
export function mcpHome(): string {
  const home = process.env.FRAZIYM_MCP_HOME?.trim();
  return home ? path.resolve(home) : path.join(fraziymHome(), "mcp");
}
