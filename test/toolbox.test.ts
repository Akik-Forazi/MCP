import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { Toolbox, xorvoidTools } from "../src/index.ts";

let ws: string;

before(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-"));
});

after(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

test("specs are OpenAI-compatible function definitions", () => {
  const tb = xorvoidTools({ workspace: ws });
  const specs = tb.specs();
  assert.ok(specs.length >= 20, `expected >= 20 tools, got ${specs.length}`);
  for (const s of specs) {
    assert.equal(s.type, "function");
    assert.equal(typeof s.function.name, "string");
    assert.ok(s.function.name.length > 0);
    assert.equal(typeof s.function.description, "string");
    assert.equal(s.function.parameters.type, "object");
    assert.equal(typeof s.function.parameters.properties, "object");
    assert.ok(Array.isArray(s.function.parameters.required));
  }
});

test("registered names cover the fix-loop set", () => {
  const tb = xorvoidTools({ workspace: ws });
  for (const name of [
    "file_read", "file_write", "file_edit", "file_patch",
    "shell_run", "web_search", "web_get",
    "git_status", "git_diff", "git_log",
    "axodex_query", "axodex_impact",
  ]) {
    assert.ok(tb.has(name), `missing tool: ${name}`);
  }
});

test("meta flags mark destructive and network tools", () => {
  const tb = xorvoidTools({ workspace: ws });
  assert.equal(tb.meta("shell_run")?.destructive, true);
  assert.equal(tb.meta("file_write")?.destructive, true);
  assert.equal(tb.meta("web_search")?.network, true);
  assert.notEqual(tb.meta("file_read")?.destructive, true);
  assert.notEqual(tb.meta("git_status")?.network, true);
});

test("unknown tool call returns an error string, does not throw", async () => {
  const tb = xorvoidTools({ workspace: ws });
  const out = await tb.call("no_such_tool", {});
  assert.ok(out.startsWith("[ERROR] Unknown tool"));
});

test("handler exceptions are caught into error strings", async () => {
  const tb = new Toolbox();
  tb.register("boom", "throws", {}, [], () => {
    throw new Error("kaboom");
  });
  const out = await tb.call("boom", {});
  assert.equal(out, "[ERROR] boom: kaboom");
});

test("file_write then file_read roundtrip", async () => {
  const tb = xorvoidTools({ workspace: ws });
  const w = await tb.call("file_write", { path: "src/a.ts", content: "export const x = 1;\n" });
  assert.ok(w.startsWith("[OK] Wrote"), w);

  const r = await tb.call("file_read", { path: "src/a.ts" });
  assert.ok(r.includes("export const x = 1;"), r);
  assert.ok(r.includes("export const x = 1;"), "content present");
});

test("file_edit replaces text", async () => {
  const tb = xorvoidTools({ workspace: ws });
  const e = await tb.call("file_edit", { path: "src/a.ts", old: "x = 1", new: "x = 2" });
  assert.ok(e.startsWith("[OK] Edited"), e);
  const r = await tb.call("file_read", { path: "src/a.ts" });
  assert.ok(r.includes("x = 2"));
  assert.ok(!r.includes("x = 1;"));
});

test("file_patch applies a unified diff", async () => {
  const tb = xorvoidTools({ workspace: ws });
  await tb.call("file_write", { path: "b.txt", content: "one\ntwo\n" });
  const p = await tb.call("file_patch", {
    path: "b.txt",
    patch: "@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
  });
  assert.ok(p.startsWith("[OK] Patch applied"), p);
  const r = await tb.call("file_read", { path: "b.txt" });
  assert.ok(r.includes("three"));
  assert.ok(!r.includes("two"));
});

test("file_search finds created files", async () => {
  const tb = xorvoidTools({ workspace: ws });
  const out = await tb.call("file_search", { pattern: "*.ts", path: "src" });
  assert.ok(out.includes("a.ts"), out);
});

test("file_grep finds content", async () => {
  const tb = xorvoidTools({ workspace: ws });
  const out = await tb.call("file_grep", { pattern: "export const", file_pattern: "*.ts" });
  assert.ok(out.includes("a.ts:1"), out);
});

test("shell_run executes and reports exit code", async () => {
  const tb = xorvoidTools({ workspace: ws });
  const out = await tb.call("shell_run", { command: "echo hello_from_mcp" });
  assert.ok(out.includes("hello_from_mcp"), out);
  assert.ok(out.includes("[exit 0]"), out);
});

test("git_status works in a fresh repo", async () => {
  const tb = xorvoidTools({ workspace: ws });
  await tb.call("shell_run", { command: "git init -q" });
  const out = await tb.call("git_status", {});
  assert.ok(out.includes("##"), out);
});

test("web tools are live-tested only when FRAZIYM_MCP_LIVE=1", { skip: process.env.FRAZIYM_MCP_LIVE !== "1" }, async () => {
  const tb = xorvoidTools({ workspace: ws });
  const out = await tb.call("web_search", { query: "node:sqlite DatabaseSync" });
  assert.ok(out.includes("Web Search Results"), out);
});
