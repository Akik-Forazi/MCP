/**
 * axonizTools group tests — proves the 72-tool surface binds to the real
 * @fraziym/axoniz classes with no dead entries.
 *
 * Isolation: USERPROFILE is sandboxed to a temp dir *before* axoniz is
 * dynamically imported, so AXONIZ_HOME (~/.axoniz/memory.json) never touches
 * the real user profile; palace/kg get explicit temp paths.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Toolbox } from "../src/core/toolbox.ts";

const EXPECTED_TOOLS = [
  // files
  "file_read",
  "file_write",
  "file_edit",
  "file_delete",
  "file_list",
  "file_search",
  "file_append",
  // shell
  "shell_run",
  "shell_python",
  // web
  "web_get",
  "web_search",
  // code
  "code_lint",
  "code_format",
  "code_tree",
  "code_analyze",
  // memory (plain KV + palace + knowledge graph + diary)
  "memory_save",
  "memory_get",
  "memory_list",
  "palace_search",
  "palace_store",
  "palace_context",
  "palace_wings",
  "palace_rooms",
  "palace_check_dup",
  "palace_delete",
  "palace_graph_traverse",
  "palace_find_tunnels",
  "palace_graph_stats",
  "kg_add",
  "kg_query",
  "kg_invalidate",
  "kg_timeline",
  "kg_stats",
  "diary_write",
  "diary_read",
  // misc
  "get_time",
  "done",
  "absolute_query",
  // agent-runtime stubs
  "swarm_spawn",
  "shadow_step",
  "war_room",
  "goal_create",
  "goal_list",
  "goal_kr_add",
  "goal_action_add",
  "goal_update_score",
  "goal_action_complete",
  "goal_report",
  // axodex
  "axodex_query",
  "axodex_context",
  "axodex_smart_read",
  "axodex_impact",
  "axodex_detect_changes",
  "axodex_status",
  "axodex_analyze",
  // git (full)
  "git_status",
  "git_diff",
  "git_log",
  "git_add",
  "git_commit",
  "git_branch",
  "git_checkout",
  "git_push",
  "git_pull",
  "git_stash",
  // computer
  "mouse_move",
  "mouse_click",
  "key_type",
  "key_press",
  "screen_size",
  "screen_capture",
  "screen_find",
];

const STUBS = [
  "swarm_spawn",
  "shadow_step",
  "war_room",
  "goal_create",
  "goal_list",
  "goal_kr_add",
  "goal_action_add",
  "goal_update_score",
  "goal_action_complete",
  "goal_report",
];

let dir = "";
let prevProfile = "";
let tb: Toolbox;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-axoniz-"));
  prevProfile = process.env.USERPROFILE ?? "";
  process.env.USERPROFILE = dir;
  const { axonizTools } = await import("../src/index.ts");
  tb = axonizTools({
    workspace: dir,
    memoryPaths: {
      palace_path: path.join(dir, ".axoniz", "palace"),
      kg_path: path.join(dir, ".axoniz", "kg"),
    },
  });
});

after(() => {
  process.env.USERPROFILE = prevProfile;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows keeps the sqlite handles of the memory layers open — leave the
    // temp dir for the OS to reap.
  }
});

test("registers exactly the 72 axoniz tools", () => {
  const names = tb.names();
  assert.equal(names.length, 72);
  assert.deepEqual([...names].sort(), [...EXPECTED_TOOLS].sort());
});

test("every spec is a well-formed OpenAI function schema", () => {
  for (const spec of tb.specs()) {
    assert.equal(spec.type, "function");
    assert.ok(spec.function.name.length > 0, "empty tool name");
    assert.ok(spec.function.description.length > 0, `${spec.function.name}: empty description`);
    assert.equal(spec.function.parameters.type, "object", spec.function.name);
    assert.ok(Array.isArray(spec.function.parameters.required), spec.function.name);
  }
});

test("file, time and protocol tools work end to end", async () => {
  const write = await tb.call("file_write", { path: "hello.txt", content: "hi fraziym" });
  assert.ok(!write.startsWith("[ERROR]"), write);

  const read = await tb.call("file_read", { path: "hello.txt" });
  assert.ok(read.includes("hi fraziym"), read);

  const year = await tb.call("get_time", { query: "year" });
  assert.match(year, /^\d{4}$/);

  const done = await tb.call("done", { result: "unit test" });
  assert.equal(done, "[done] unit test");
});

test("git full surface: init, stage, commit, log", async () => {
  const init = await tb.call("shell_run", { command: "git init -q" });
  assert.ok(!init.startsWith("[ERROR]"), init);

  const cfg = await tb.call("shell_run", {
    command: "git config user.email test@fraziym.dev && git config user.name fraziym-test",
  });
  assert.ok(!cfg.startsWith("[ERROR]"), cfg);

  await tb.call("file_write", { path: "a.txt", content: "a" });

  const add = await tb.call("git_add", { path: "." });
  assert.ok(!add.startsWith("[ERROR]"), add);

  const commit = await tb.call("git_commit", { message: "test: initial" });
  assert.ok(!commit.startsWith("[ERROR]"), commit);

  const log = await tb.call("git_log", { count: 5 });
  assert.ok(log.includes("test: initial"), log);
});

test("memory key-value tools round-trip", async () => {
  const saved = await tb.call("memory_save", { key: "fraziym_test", value: "works" });
  assert.ok(!saved.startsWith("[ERROR]"), saved);

  const got = await tb.call("memory_get", { key: "fraziym_test" });
  assert.ok(got.includes("works"), got);

  const list = await tb.call("memory_list", {});
  assert.ok(list.includes("fraziym_test"), list);
});

test("memory-family tools always resolve to strings (bound, never Unknown)", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["palace_context", { query: "fraziym" }],
    ["palace_wings", {}],
    ["palace_rooms", {}],
    ["kg_add", { subject: "fraziym", predicate: "is", object: "mcp" }],
    ["kg_query", { entity: "fraziym" }],
    ["kg_timeline", {}],
    ["kg_stats", {}],
    ["diary_write", { content: "fraziym mcp test entry" }],
    ["diary_read", {}],
  ];
  for (const [name, args] of calls) {
    const out = await tb.call(name, args);
    assert.equal(typeof out, "string", name);
    assert.ok(!out.startsWith("[ERROR] Unknown tool"), `${name} is not bound`);
  }
});

test("agent-runtime stubs return explicit errors", async () => {
  const minimal: Record<string, Record<string, unknown>> = {
    swarm_spawn: { task: "x" },
    shadow_step: { task: "x" },
    war_room: { topic: "x" },
    goal_create: { title: "x" },
    goal_kr_add: { goal_id: "g", title: "x" },
    goal_action_add: { kr_id: "k", title: "x" },
    goal_update_score: { goal_id: "g", score: 1 },
    goal_action_complete: { action_id: "a" },
  };
  for (const name of STUBS) {
    const out = await tb.call(name, minimal[name] ?? {});
    assert.ok(out.startsWith("[ERROR]"), `${name}: ${out}`);
    assert.ok(out.includes("axoniz agent runtime"), out);
  }
});

test("capability metadata flags risky tools", () => {
  assert.deepEqual(tb.meta("git_push"), { destructive: true, network: true });
  assert.deepEqual(tb.meta("git_status"), { readOnly: true });
  assert.deepEqual(tb.meta("palace_store"), { destructive: true });
  assert.deepEqual(tb.meta("file_read"), { readOnly: true });
  assert.deepEqual(tb.meta("mouse_move"), { destructive: true });
});

test("absolute_query merges code-graph and palace sections", async () => {
  const out = await tb.call("absolute_query", { query: "fraziym" });
  assert.ok(out.includes("Axodex (code graph)"), out);
  assert.ok(out.includes("Palace (long-term memory)"), out);
});
