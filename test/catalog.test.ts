/**
 * Catalog tests — the static snapshot must always equal the live registrars,
 * and the lazy host must serve listings + calls from it without drift.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { loadCatalog, toolsForGroup } from "../src/core/catalog.ts";

let dir = "";
let prevProfile = "";

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-catalog-test-"));
  prevProfile = process.env.USERPROFILE ?? "";
  process.env.USERPROFILE = dir;
});

after(() => {
  process.env.USERPROFILE = prevProfile;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* sqlite handles may linger on Windows */
  }
});

test("catalog covers exactly 74 tools (72 axoniz + 2 xorvoid extras)", () => {
  const cat = loadCatalog();
  assert.ok(cat, "catalog.json missing — run `npm run catalog`");
  assert.equal(cat.tools.length, 74);
  assert.equal(toolsForGroup(cat, "axoniz").length, 72);
  assert.equal(toolsForGroup(cat, "xorvoid").length, 25);
  assert.equal(toolsForGroup(cat, "all").length, 74);

  const extras = cat.tools
    .filter((t) => t.groups.length === 1 && t.groups[0] === "xorvoid")
    .map((t) => t.name);
  assert.deepEqual(extras.sort(), ["file_grep", "file_patch"]);
});

test("catalog equals the live registrars (no drift)", async () => {
  const { axonizTools, xorvoidTools } = await import("../src/index.ts");
  const ax = axonizTools({
    workspace: dir,
    memoryPaths: {
      palace_path: path.join(dir, ".axoniz", "palace"),
      kg_path: path.join(dir, ".axoniz", "kg"),
    },
  });
  const xv = xorvoidTools({ workspace: dir });

  const cat = loadCatalog();
  assert.ok(cat);
  const byName = new Map(cat.tools.map((t) => [t.name, t]));

  const live = [...ax.list(), ...xv.list()];
  const liveNames = new Set(live.map((t) => t.schema.function.name));

  for (const t of live) {
    const name = t.schema.function.name;
    const c = byName.get(name);
    assert.ok(c, `${name} missing from catalog`);
    assert.equal(c.description, t.schema.function.description, `${name}: description drift`);
    assert.deepEqual(c.inputSchema, t.schema.function.parameters, `${name}: schema drift`);
    assert.deepEqual(c.meta, t.meta, `${name}: meta drift`);
  }
  for (const c of cat.tools) {
    assert.ok(liveNames.has(c.name), `${c.name} in catalog but not live`);
  }
});

test("lazy host lists from catalog and builds families on first call", async () => {
  const { LazyToolHost } = await import("../src/core/host.ts");
  const host = new LazyToolHost({ group: "all", workspace: dir });

  assert.equal(host.names().length, 74);
  assert.equal(host.specs().length, 74);

  const ro = new LazyToolHost({ group: "all", workspace: dir, readOnly: true });
  assert.ok(!ro.names().includes("file_write"));
  assert.ok(ro.names().includes("file_read"));

  const nn = new LazyToolHost({ group: "all", workspace: dir, noNetwork: true });
  assert.ok(!nn.names().includes("web_get"));
  assert.ok(nn.names().includes("git_status"));

  const unknown = await host.call("not_a_tool", {});
  assert.equal(unknown, "[ERROR] Unknown tool: not_a_tool");
});

test("tool definitions publish MCP annotations from meta", async () => {
  const { LazyToolHost } = await import("../src/core/host.ts");
  const host = new LazyToolHost({ group: "all", workspace: dir });
  const defs = host.definitions();
  assert.equal(defs.length, 74);

  const byName = new Map(defs.map((d) => [d.name, d]));
  assert.deepEqual(byName.get("file_read")?.annotations, { readOnlyHint: true, destructiveHint: false });
  assert.deepEqual(byName.get("file_write")?.annotations, { destructiveHint: true });
  assert.deepEqual(byName.get("web_get")?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  });
  assert.equal(byName.get("git_add")?.annotations, undefined);

  const readSchema = byName.get("file_read")?.inputSchema as {
    properties?: Record<string, { maxLength?: number }>;
  };
  assert.equal(readSchema.properties?.path?.maxLength, 4096);
});

test("lazy host calls work end to end: protocol, files, jail, stubs", async () => {
  const { LazyToolHost } = await import("../src/core/host.ts");
  const host = new LazyToolHost({ group: "all", workspace: dir });

  const year = await host.call("get_time", { query: "year" });
  assert.match(year, /^\d{4}$/);

  const write = await host.call("file_write", { path: "host.txt", content: "lazy" });
  assert.ok(!write.startsWith("[ERROR]"), write);

  const read = await host.call("file_read", { path: "host.txt" });
  assert.ok(read.includes("lazy"), read);

  const escape = await host.call("file_read", { path: "../outside.txt" });
  assert.ok(escape.startsWith("[ERROR]"), escape);
  assert.ok(escape.includes("escapes workspace"), escape);

  const stub = await host.call("goal_list", {});
  assert.ok(stub.includes("axoniz agent runtime"), stub);
});
