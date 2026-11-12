/**
 * gen-catalog — snapshot every group's tools into catalog.json.
 *
 * Runs the *real* registrar functions (axonizTools/xorvoidTools/qaTools/secTools)
 * with a sandboxed USERPROFILE so no real ~/.axoniz state is touched, then writes a
 * deterministic JSON file the serve/tools fast paths read directly.
 *
 *   npm run catalog
 *
 * Group tool counts are data-driven here (GROUP_TOOL_COUNTS).
 * Changing a group's count requires updating GROUP_TOOL_COUNTS,
 * not touching assert bodies.
 */

/**
 * Group tool counts — used by gen-catalog.ts and test assertions.
 * Change here, not in assert bodies.
 */
const GROUP_TOOL_COUNTS = {
  axoniz: {
    standalone: 52,  // without optional @fraziym/axoniz memory backend
    withMemory: 72,  // when @fraziym/axoniz is installed as optional peer
  },
  xorvoid: 25,
  qaTools: 49,  // core (files/shell/web/code/computer/axodex: 39) + 8 QA + 3 stubs + 7 goals
  secTools: 48, // core (files/shell/web/code/computer/axodex: 39) + 7 SEC + 3 stubs + 7 goals + overlap
};

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RegisteredTool } from "../src/core/types.ts";
import type { CatalogTool } from "../src/core/catalog.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-catalog-"));
process.env.USERPROFILE = sandbox;

const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const { axonizTools } = await import("../src/groups/axoniz.ts");
const { xorvoidTools } = await import("../src/groups/xorvoid.ts");
const { qaTools } = await import("../src/groups/qaTools.ts");
const { secTools } = await import("../src/groups/secTools.ts");

function entry(t: RegisteredTool, groups: CatalogTool["groups"]): CatalogTool {
  return {
    name: t.schema.function.name,
    groups,
    description: t.schema.function.description,
    inputSchema: t.schema.function.parameters,
    meta: t.meta,
  };
}

try {
  const ax = axonizTools({
    workspace: sandbox,
    memoryPaths: {
      palace_path: path.join(sandbox, ".axoniz", "palace"),
      kg_path: path.join(sandbox, ".axoniz", "kg"),
    },
  });
  const xv = xorvoidTools({ workspace: sandbox });

  const MEMORY_TOOL_COUNT = 20;

  const axCount = ax.names().length;
  const xvCount = xv.names().length;
  const qaCount = qaTools({ workspace: sandbox }).names().length;
  const secCount = secTools({ workspace: sandbox }).names().length;

  if (
    axCount !== GROUP_TOOL_COUNTS.axoniz.standalone &&
    axCount !== GROUP_TOOL_COUNTS.axoniz.withMemory
  ) {
    throw new Error(
      `axoniz group has ${axCount} tools, expected ${GROUP_TOOL_COUNTS.axoniz.standalone} (standalone) or ${GROUP_TOOL_COUNTS.axoniz.withMemory} (with memory)`,
    );
  }

  if (xvCount !== GROUP_TOOL_COUNTS.xorvoid) {
    throw new Error(
      `xorvoid group has ${xvCount} tools, expected ${GROUP_TOOL_COUNTS.xorvoid}`,
    );
  }

  if (qaCount !== GROUP_TOOL_COUNTS.qaTools) {
    throw new Error(
      `qaTools group has ${qaCount} tools, expected ${GROUP_TOOL_COUNTS.qaTools}`,
    );
  }

  if (secCount !== GROUP_TOOL_COUNTS.secTools) {
    throw new Error(
      `secTools group has ${secCount} tools, expected ${GROUP_TOOL_COUNTS.secTools}`,
    );
  }

  const tools: CatalogTool[] = [];
  const axNames = new Set(ax.names());
  const xvNames = new Set(xv.names());
  const qaNames = new Set(qaTools({ workspace: sandbox }).names());
  const secNames = new Set(secTools({ workspace: sandbox }).names());

  for (const t of ax.list()) {
    const name = t.schema.function.name;
    const groups: string[] = ["axoniz"];
    if (xvNames.has(name)) groups.push("xorvoid");
    if (qaNames.has(name)) groups.push("qaTools");
    if (secNames.has(name)) groups.push("secTools");
    tools.push(entry(t, groups));
  }
  for (const t of xv.list()) {
    const name = t.schema.function.name;
    if (!axNames.has(name)) tools.push(entry(t, ["xorvoid"]));
  }
  for (const t of qaTools({ workspace: sandbox }).list()) {
    const name = t.schema.function.name;
    if (!axNames.has(name) && !xvNames.has(name))
      tools.push(entry(t, ["qaTools"]));
  }
  for (const t of secTools({ workspace: sandbox }).list()) {
    const name = t.schema.function.name;
    if (!axNames.has(name) && !xvNames.has(name) && !qaNames.has(name))
      tools.push(entry(t, ["secTools"]));
  }

  const catalog = { version: pkg.version, tools };
  fs.writeFileSync(
    new URL("../catalog.json", import.meta.url),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  process.stderr.write(
    `[catalog] wrote ${tools.length} tools (axoniz ${axCount}, xorvoid ${xvCount}, qaTools ${qaCount}, secTools ${secCount}) for v${pkg.version}\n`,
  );
} finally {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows may keep memory store handles open — OS reaps the temp dir */
  }
}
