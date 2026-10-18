/**
 * CLI helpers — group resolution and package metadata.
 */

import fs from "node:fs";

import type { Toolbox } from "../core/toolbox.ts";
import { axonizTools } from "../groups/axoniz.ts";
import { xorvoidTools } from "../groups/xorvoid.ts";

export type ToolGroup = "axoniz" | "xorvoid" | "all";

export function pkgVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    const data = JSON.parse(fs.readFileSync(url, "utf8")) as { version?: string };
    return data.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Build the Toolbox for a group: axoniz 72, xorvoid 25, or "all" (merged, deduped). */
export function toolboxFor(group: ToolGroup, workspace: string): Toolbox {
  if (group === "xorvoid") return xorvoidTools({ workspace });
  if (group === "all") return axonizTools({ workspace }).merge(xorvoidTools({ workspace }));
  return axonizTools({ workspace });
}
