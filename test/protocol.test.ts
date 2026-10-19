/**
 * Protocol core tests — negotiation matrix, tools/list & tools/call, batch
 * handling, cancellation response-dropping, and error parity.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CoreServer,
  LATEST_LEGACY_VERSION,
  MODERN_VERSION,
  type ToolHostLike,
} from "../src/protocol/server.ts";
import type { ToolFunctionSchema } from "../src/core/types.ts";

const SPEC: ToolFunctionSchema = {
  type: "function",
  function: {
    name: "echo",
    description: "echo text",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: [] },
  },
};

function makeHost(overrides: Partial<ToolHostLike> = {}): ToolHostLike {
  return {
    names: () => ["echo"],
    specs: () => [SPEC],
    call: async (_name, args) => (args.text === "boom" ? "[ERROR] echo: boom" : String(args.text ?? "")),
    ...overrides,
  };
}

function server(host = makeHost()): CoreServer {
  return new CoreServer({ host, version: "0.0.0-test", log: () => {} });
}

async function rpc(s: CoreServer, id: number, method: string, params?: unknown): Promise<any> {
  const res = (await s.handleMessage({ jsonrpc: "2.0", id, method, params })) as any;
  return res;
}

test("initialize echoes supported versions and falls back to latest", async () => {
  const s = server();
  for (const v of ["2024-11-05", "2025-03-26", "2025-06-18"]) {
    const res = await rpc(s, 1, "initialize", { protocolVersion: v });
    assert.equal(res.result.protocolVersion, v);
    assert.equal(res.result.serverInfo.name, "fraziym-mcp");
    assert.ok(typeof res.result.instructions === "string" && res.result.instructions.length > 10);
    assert.deepEqual(res.result.capabilities.tools, { listChanged: false });
  }
  const unknown = await rpc(s, 2, "initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.result.protocolVersion, LATEST_LEGACY_VERSION);
});

test("tools/list returns host specs; tools/call returns content and isError", async () => {
  const s = server();
  const list = await rpc(s, 1, "tools/list", {});
  assert.equal(list.result.tools.length, 1);
  assert.equal(list.result.tools[0].name, "echo");
  assert.equal(list.result.tools[0].inputSchema.type, "object");

  const ok = await rpc(s, 2, "tools/call", { name: "echo", arguments: { text: "hi" } });
  assert.equal(ok.result.content[0].text, "hi");
  assert.equal(ok.result.isError, false);

  const err = await rpc(s, 3, "tools/call", { name: "echo", arguments: { text: "boom" } });
  assert.equal(err.result.isError, true);
});

test("parse error, invalid request and unknown method codes", async () => {
  const s = server();
  const parse = JSON.parse((await s.handleLine("{nope")) ?? "{}") as any;
  assert.equal(parse.error.code, -32700);
  const invalid = (await s.handleMessage(42)) as any;
  assert.equal(invalid.error.code, -32600);
  const unknown = await rpc(s, 1, "no/such/method", {});
  assert.equal(unknown.error.code, -32601);
});

test("batch requests are answered as an array; notifications are silent", async () => {
  const s = server();
  const res = (await s.handleMessage([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ])) as any[];
  assert.ok(Array.isArray(res));
  assert.equal(res.length, 2);
  assert.equal(res[0].id, 1);
  assert.equal(res[1].id, 2);
});

test("cancelled calls drop their response", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const host = makeHost({
    call: async () => {
      await gate;
      return "late";
    },
  });
  const s = server(host);

  const pending = s.handleMessage({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "echo", arguments: {} },
  });
  await s.handleMessage({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 7 },
  });
  release?.();
  const res = await pending;
  assert.equal(res, null, "cancelled response must be dropped");
});

test("logging/setLevel and ping are lifecycle-safe", async () => {
  const s = server();
  const level = await rpc(s, 1, "logging/setLevel", { level: "debug" });
  assert.deepEqual(level.result, {}, "legacy results stay schema-clean");
  assert.equal(s.level, "debug");
  const pong = await rpc(s, 2, "ping", {});
  assert.deepEqual(pong.result, {});

  const modernPing = await rpc(s, 3, "ping", {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });
  assert.equal(modernPing.error.code, -32601, "ping was removed in 2026-07-28");
});

test("server/discover returns the 2026-07-28 DiscoverResult shape", async () => {
  const s = server();
  const res = await rpc(s, 1, "server/discover", {});
  assert.equal(res.result.resultType, "complete");
  assert.ok(Array.isArray(res.result.supportedVersions));
  assert.ok(res.result.supportedVersions.includes(MODERN_VERSION));
  assert.ok(res.result.supportedVersions.includes(LATEST_LEGACY_VERSION));
  assert.equal(typeof res.result.ttlMs, "number");
  assert.equal(res.result.cacheScope, "public");
  assert.equal(res.result._meta["io.modelcontextprotocol/serverInfo"].name, "fraziym-mcp");
  assert.equal(res.result.capabilities.tools.listChanged, false);
  assert.ok(typeof res.result.instructions === "string");
});

test("modern per-request _meta on stdio is validated", async () => {
  const s = server();
  const ok = await rpc(s, 1, "tools/list", {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });
  assert.equal(ok.result.tools.length, 1);
  assert.equal(typeof ok.result.ttlMs, "number");
  assert.equal(ok.result.cacheScope, "public");

  const badVersion = await rpc(s, 2, "tools/list", {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "1900-01-01",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });
  assert.equal(badVersion.error.code, -32022);
  assert.ok(badVersion.error.data.supported.includes(MODERN_VERSION));
  assert.equal(badVersion.error.data.requested, "1900-01-01");

  const noCaps = await rpc(s, 3, "tools/list", {
    _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION },
  });
  assert.equal(noCaps.error.code, -32602);
});
