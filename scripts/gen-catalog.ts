/**
 * gen-catalog — snapshot every group's tools into catalog.json.
 *
 * Runs the *real* registrar functions (axonizTools/xorvoidTools) with a
 * sandboxed USERPROFILE so no real ~/.axoniz state is touched, then writes a
 * deterministic JSON file the serve/tools fast paths read directly.
 *
 *   npm run catalog
 */

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

  if (ax.names().length !== 72) {
    throw new Error(`axoniz group has ${ax.names().length} tools, expected 72`);
  }
  if (xv.names().length !== 25) {
    throw new Error(`xorvoid group has ${xv.names().length} tools, expected 25`);
  }

  const tools: CatalogTool[] = [];
  const axNames = new Set(ax.names());
  const xvNames = new Set(xv.names());
  for (const t of ax.list()) {
    const name = t.schema.function.name;
    tools.push(entry(t, xvNames.has(name) ? ["axoniz", "xorvoid"] : ["axoniz"]));
  }
  for (const t of xv.list()) {
    const name = t.schema.function.name;
    if (!axNames.has(name)) tools.push(entry(t, ["xorvoid"]));
  }

  const catalog = { version: pkg.version, tools };
  fs.writeFileSync(
    new URL("../catalog.json", import.meta.url),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  process.stderr.write(
    `[catalog] wrote ${tools.length} tools (axoniz 72 + xorvoid extras ${tools.length - 72}) for v${pkg.version}\n`,
  );
} finally {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* Windows may keep memory store handles open — OS reaps the temp dir */
  }
}
