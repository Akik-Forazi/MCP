/**
 * Package version reader — deliberately dependency-free so `fraziym-mcp
 * version` (and the exe launcher path) never import tool code.
 */

import fs from "node:fs";

export function pkgVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const data = JSON.parse(fs.readFileSync(url, "utf8")) as { version?: string };
    return data.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
