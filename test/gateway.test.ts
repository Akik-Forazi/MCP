/**
 * Gateway endpoints — offline tests. A tiny in-process OpenAI-compatible mock
 * stands in for provider HTTP; everything else (router selection, failover,
 * race, fix queue, shadow worktrees, discover, audit tail) runs for real in a
 * throwaway workspace + $FRAZIYM_MCP_HOME.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { createFamilyContext } from "../src/core/families.ts";
import { LazyToolHost } from "../src/core/host.ts";
import { mcpHome } from "../src/gateway/config.ts";
import { GatewayHost } from "../src/gateway/host.ts";
import { buildGatewayToolbox, GATEWAY_TOOL_NAMES } from "../src/gateway/registry.ts";

const prevHome = process.env.FRAZIYM_MCP_HOME;
const prevAudit = process.env.FRAZIYM_MCP_AUDIT;
const prevConfigHome = process.env.FRAZIYM_HOME;
let home = "";
let workspace = "";
let server: http.Server;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-gw-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-gw-ws-"));
  delete process.env.FRAZIYM_MCP_AUDIT;
  process.env.FRAZIYM_MCP_HOME = home;
  process.env.FRAZIYM_HOME = home;

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let model = "unknown";
      try {
        model = (JSON.parse(body) as { model?: string }).model ?? "unknown";
      } catch {
        /* ignore */
      }
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? "";
      if (url.startsWith("/flaky/")) return send(500, { error: "boom" });
      if (url.startsWith("/bad400/")) return send(400, { error: "bad request" });
      if (url.startsWith("/slow/")) {
        setTimeout(() => send(200, { model, choices: [{ message: { content: `reply:${model}` } }] }), 300);
        return;
      }
      send(200, { model, choices: [{ message: { content: `reply:${model}` } }] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${String(address.port)}`;

  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify(
      {
        providers: [
          { name: "flaky", kind: "openai", baseUrl: `${origin}/flaky/v1`, apiKey: "test", models: ["ok1"] },
          { name: "fast", kind: "openai", baseUrl: `${origin}/fast/v1`, apiKey: "test", models: ["fast", "ok2"] },
          { name: "slow", kind: "openai", baseUrl: `${origin}/slow/v1`, apiKey: "test", models: ["slow"] },
          { name: "nokey", kind: "openai", baseUrl: `${origin}/bad400/v1`, apiKeyEnv: "GATEWAY_TEST_MISSING_KEY", models: ["fail400"] },
        ],
        verify: [
          { name: "ok", cmd: process.execPath, args: ["-e", "console.log('verify-ok')"] },
          { name: "bad", cmd: process.execPath, args: ["-e", "process.exit(3)"] },
        ],
      },
      null,
      2,
    ),
  );
});

after(() => {
  server?.close();
  if (prevHome === undefined) delete process.env.FRAZIYM_MCP_HOME;
  else process.env.FRAZIYM_MCP_HOME = prevHome;
  if (prevAudit === undefined) delete process.env.FRAZIYM_MCP_AUDIT;
  else process.env.FRAZIYM_MCP_AUDIT = prevAudit;
  if (prevConfigHome === undefined) delete process.env.FRAZIYM_HOME;
  else process.env.FRAZIYM_HOME = prevConfigHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function toolbox(configHome?: string) {
  return buildGatewayToolbox({
    workspace,
    home,
    ...(configHome ? { configHome } : {}),
    ctx: createFamilyContext(workspace, { agentName: "gateway-test" }),
  });
}

test("router_status reports providers and key presence without key material", async () => {
  const out = await toolbox().call("router_status", {});
  assert.match(out, /providers: 4/);
  assert.match(out, /flaky.*key:present/);
  assert.match(out, /nokey.*key:MISSING/);
  assert.ok(!out.includes("test"), "must not echo api keys");
});

test("router_ask fails over across providers", async () => {
  const out = await toolbox().call("router_ask", { prompt: "hi", model: "ok1" });
  assert.match(out, /reply:ok1/);
  assert.match(out, /router_ask via fast · ok1/);
});

test("router_ask surfaces non-retryable provider errors", async () => {
  const out = await toolbox().call("router_delegate", { task: "hi", model: "fail400" });
  assert.match(out, /^\[ERROR\]/);
  assert.match(out, /HTTP 400/);
});

test("router_race returns the first successful completion", async () => {
  const out = await toolbox().call("router_race", { prompt: "hi", models: "slow,fast" });
  assert.match(out, /reply:fast/);
  assert.match(out, /won by fast · fast/);
});

test("router_delegate routes to the provider that lists the model", async () => {
  const out = await toolbox().call("router_delegate", { task: "do it", model: "ok2" });
  assert.match(out, /reply:ok2/);
  assert.match(out, /delegate to fast · ok2/);
});

test("fix_verify runs configured commands and reports pass/fail", async () => {
  const all = await toolbox().call("fix_verify", {});
  assert.match(all, /\[PASS\] ok/);
  assert.match(all, /\[FAIL\] bad \(exit 3\)/);
  assert.match(all, /verify: 1\/2 passed/);
  const one = await toolbox().call("fix_verify", { name: "ok" });
  assert.match(one, /verify: 1\/1 passed/);
  const missing = await toolbox().call("fix_verify", { name: "nope" });
  assert.match(missing, /^\[ERROR\] no verify command named 'nope'/);
});

test("fix_queue pull/complete lifecycle", async () => {
  fs.writeFileSync(
    path.join(home, "fix-queue.jsonl"),
    [
      JSON.stringify({ id: "fx-1", created: new Date().toISOString(), title: "fix one" }),
      JSON.stringify({ id: "fx-2", created: new Date().toISOString(), title: "fix two" }),
      "",
    ].join("\n"),
  );
  const tb = toolbox();
  const first = await tb.call("fix_queue_pull", {});
  assert.match(first, /\[PULL\].*"id":"fx-1"/);
  const second = await tb.call("fix_queue_pull", {});
  assert.match(second, /\[PULL\].*"id":"fx-2"/);
  const empty = await tb.call("fix_queue_pull", {});
  assert.match(empty, /^\[EMPTY\]/);
  const done = await tb.call("fix_queue_complete", { id: "fx-1", ok: true, note: "done" });
  assert.match(done, /\[DONE\] fx-1/);
  const unknown = await tb.call("fix_queue_complete", { id: "fx-404", ok: false });
  assert.match(unknown, /^\[ERROR\] unknown fix id 'fx-404'/);
});

test("fix_shadow runs the test in a throwaway worktree and leaves the workspace untouched", async () => {
  fs.writeFileSync(path.join(workspace, "seed.txt"), "base\n");
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "gw@test.local"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "gw-test"], { cwd: workspace });
  execFileSync("git", ["add", "seed.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: workspace });

  const tb = toolbox();
  const pass = await tb.call("fix_shadow", {
    test_cmd: "node -e \"process.exit(0)\"",
    files: [{ path: "seed.txt", content: "shadow\n" }],
  });
  assert.match(pass, /\[SHADOW PASS\]/);

  const fail = await tb.call("fix_shadow", {
    test_cmd: "node -e \"process.exit(1)\"",
    files: [{ path: "seed.txt", content: "shadow\n" }],
  });
  assert.match(fail, /\[SHADOW FAIL\]/);
  assert.match(fail, /exit 1/);

  const escape = await tb.call("fix_shadow", {
    test_cmd: "echo nope",
    files: [{ path: "../escape.txt", content: "x" }],
  });
  assert.match(escape, /^\[ERROR\]/);

  assert.equal(fs.readFileSync(path.join(workspace, "seed.txt"), "utf8"), "base\n");
  assert.ok(!fs.existsSync(path.join(path.dirname(workspace), "escape.txt")));
});

test("tools_discover ranks catalog tools by query", async () => {
  const out = await toolbox().call("tools_discover", { query: "read a file", limit: 5 });
  assert.match(out, /file_read/);
  assert.ok(out.split("\n").length <= 12);
  const none = await toolbox().call("tools_discover", { query: "zzzz_nothing_zzzz" });
  assert.match(none, /No catalog tool matches/);
});

test("audit_tail filters the audit log", async () => {
  const lines = [
    { tool: "file_read", argsHash: "a", ms: 3 },
    { tool: "git_status", argsHash: "b", ms: 4 },
    { tool: "file_read", argsHash: "c", ms: 5 },
  ];
  fs.writeFileSync(path.join(home, "audit.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const out = await toolbox().call("audit_tail", { lines: 10, tool: "file_read" });
  assert.match(out, /2 of 3 entries/);
  assert.match(out, /"argsHash":"c"/);
  const all = await toolbox().call("audit_tail", { lines: 2 });
  assert.match(all, /2 of 3 entries/);
});

test("GatewayHost advertises 74 catalog tools + 13 gateway tools with annotations", () => {
  const host = new GatewayHost(new LazyToolHost({ workspace, guard: false }), { home, guard: false });
  const names = host.names();
  assert.equal(names.length, 74 + GATEWAY_TOOL_NAMES.length);
  const defs = host.definitions();
  const status = defs.find((d) => d.name === "router_status");
  assert.ok(status);
  assert.equal(status.annotations?.readOnlyHint, true);
  const remember = defs.find((d) => d.name === "brain_remember");
  assert.ok(remember);
  assert.equal(remember.annotations?.readOnlyHint, undefined);
});

test("shared config supports an 'mcp' section alongside other products", async () => {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-gw-shared-"));
  fs.writeFileSync(
    path.join(shared, "config.json"),
    JSON.stringify({
      "other-product": { some: "settings" },
      mcp: {
        providers: [{ name: "nested-svc", kind: "openai", baseUrl: "http://127.0.0.1:1/v1", models: [] }],
        verify: [{ name: "nested", cmd: process.execPath, args: ["-e", "process.exit(0)"] }],
      },
    }),
  );
  const tb = toolbox(shared);
  const status = await tb.call("router_status", {});
  assert.match(status, /nested-svc/);
  assert.match(status, /verify commands: nested/);
  const verify = await tb.call("fix_verify", { name: "nested" });
  assert.match(verify, /\[PASS\] nested/);
  fs.rmSync(shared, { recursive: true, force: true });
});

test("mcp state lives in the machine-local fraziym cache (T2)", () => {
  const prevState = process.env.FRAZIYM_MCP_HOME;
  const prevLocal = process.env.FRAZIYM_LOCAL;
  delete process.env.FRAZIYM_MCP_HOME;
  process.env.FRAZIYM_LOCAL = path.join("tmp", "fraziym-local");
  try {
    assert.equal(mcpHome(), path.resolve("tmp", "fraziym-local", "mcp"));
  } finally {
    if (prevState === undefined) delete process.env.FRAZIYM_MCP_HOME;
    else process.env.FRAZIYM_MCP_HOME = prevState;
    if (prevLocal === undefined) delete process.env.FRAZIYM_LOCAL;
    else process.env.FRAZIYM_LOCAL = prevLocal;
  }
});
