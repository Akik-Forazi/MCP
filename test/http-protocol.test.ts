/**
 * Streamable HTTP transport tests — the 2026-07-28 stateless core:
 * cold server/discover + tools/list, no session id, resultType, ttlMs +
 * cacheScope, -32022, -32020 header/body validation, legacy dual-era,
 * Origin checks, token auth, and status-code mapping.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { serveHttp, type HttpServeHandle } from "../src/protocol/http.ts";
import { CoreServer, MODERN_VERSION, type ToolHostLike } from "../src/protocol/server.ts";
import type { ToolFunctionSchema } from "../src/core/types.ts";

function spec(name: string): ToolFunctionSchema {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: { text: { type: "string", maxLength: 4096 } }, required: [] },
    },
  };
}

function makeHost(): ToolHostLike {
  return {
    names: () => ["echo", "ec ho"],
    specs: () => [spec("echo"), spec("ec ho")],
    call: async (name, args) => `${name}:${String(args.text ?? "")}`,
  };
}

interface ServerOpts {
  token?: string;
  allowOrigins?: string[];
  rateLimit?: { burst: number; perSecond: number } | false;
}

async function withServer(
  fn: (url: string, handle: HttpServeHandle) => Promise<void>,
  opts: ServerOpts = {},
): Promise<void> {
  const server = new CoreServer({ host: makeHost(), version: "0.0.0-test", log: () => {} });
  const handle = await serveHttp({ server, port: 0, log: () => {}, ...opts });
  try {
    await fn(handle.url, handle);
  } finally {
    await handle.close();
  }
}

const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CAPS_META = "io.modelcontextprotocol/clientCapabilities";

function modernMeta(version: string = MODERN_VERSION): Record<string, unknown> {
  return {
    [VERSION_META]: version,
    "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
    [CAPS_META]: {},
  };
}

function headers(method: string, name?: string, version: string = MODERN_VERSION): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "MCP-Protocol-Version": version,
    "Mcp-Method": method,
    ...(name !== undefined ? { "Mcp-Name": name } : {}),
  };
}

function request(method: string, params: Record<string, unknown> = {}, id: unknown = 1, version: string = MODERN_VERSION): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: modernMeta(version) } };
}

async function post(url: string, hdrs: Record<string, string>, payload: unknown): Promise<{ status: number; body: any; res: Response }> {
  const res = await fetch(url, { method: "POST", headers: hdrs, body: JSON.stringify(payload) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

test("cold server/discover passes the full 2026-07-28 surface", async () => {
  await withServer(async (url) => {
    const { status, body, res } = await post(url, headers("server/discover"), request("server/discover"));
    assert.equal(status, 200);
    assert.equal(res.headers.get("mcp-session-id"), null, "no session id may be minted");
    assert.equal(body.result.resultType, "complete");
    assert.ok(body.result.supportedVersions.includes(MODERN_VERSION));
    assert.equal(typeof body.result.ttlMs, "number");
    assert.equal(body.result.cacheScope, "public");
    assert.equal(body.result._meta["io.modelcontextprotocol/serverInfo"].name, "fraziym-mcp");
    assert.ok(typeof body.result.instructions === "string");
  });
});

test("cold tools/list answers request #1 with cacheable results", async () => {
  await withServer(async (url) => {
    const { status, body, res } = await post(url, headers("tools/list"), request("tools/list"));
    assert.equal(status, 200);
    assert.equal(res.headers.get("mcp-session-id"), null);
    assert.equal(body.result.resultType, "complete");
    assert.equal(body.result.tools.length, 2);
    assert.equal(typeof body.result.ttlMs, "number");
    assert.equal(body.result.cacheScope, "public");
  });
});

test("tools/call executes with matching Mcp-Name header", async () => {
  await withServer(async (url) => {
    const { status, body } = await post(
      url,
      headers("tools/call", "echo"),
      request("tools/call", { name: "echo", arguments: { text: "hi" } }),
    );
    assert.equal(status, 200);
    assert.equal(body.result.resultType, "complete");
    assert.equal(body.result.content[0].text, "echo:hi");
    assert.equal(body.result.isError, false);
  });
});

test("Mcp-Name via base64 sentinel is decoded before comparison", async () => {
  await withServer(async (url) => {
    const encoded = `=?base64?${Buffer.from("ec ho").toString("base64")}?=`;
    const { status, body } = await post(
      url,
      headers("tools/call", encoded),
      request("tools/call", { name: "ec ho", arguments: {} }),
    );
    assert.equal(status, 200);
    assert.equal(body.result.content[0].text, "ec ho:");
  });
});

test("header/body mismatches are rejected with -32020", async () => {
  await withServer(async (url) => {
    const nameMismatch = await post(
      url,
      headers("tools/call", "other"),
      request("tools/call", { name: "echo", arguments: {} }),
    );
    assert.equal(nameMismatch.status, 400);
    assert.equal(nameMismatch.body.error.code, -32020);

    const missingName = await post(url, headers("tools/call"), request("tools/call", { name: "echo", arguments: {} }));
    assert.equal(missingName.status, 400);
    assert.equal(missingName.body.error.code, -32020);

    const methodMismatch = await post(url, headers("tools/list"), request("tools/call", { name: "echo" }));
    assert.equal(methodMismatch.status, 400);
    assert.equal(methodMismatch.body.error.code, -32020);

    const missingMethod = await post(url, { "Content-Type": "application/json", "MCP-Protocol-Version": MODERN_VERSION }, request("tools/list"));
    assert.equal(missingMethod.status, 400);
    assert.equal(missingMethod.body.error.code, -32020);

    const metaMismatch = await post(url, headers("tools/list"), request("tools/list", {}, 1, "2025-06-18"));
    assert.equal(metaMismatch.status, 400);
    assert.equal(metaMismatch.body.error.code, -32020);
  });
});

test("unsupported versions get -32022 with the supported list", async () => {
  await withServer(async (url) => {
    const { status, body } = await post(
      url,
      headers("tools/list", undefined, "1900-01-01"),
      request("tools/list"),
    );
    assert.equal(status, 400);
    assert.equal(body.error.code, -32022);
    assert.ok(body.error.data.supported.includes(MODERN_VERSION));
    assert.equal(body.error.data.requested, "1900-01-01");
  });
});

test("missing clientCapabilities is -32602 (required _meta field)", async () => {
  await withServer(async (url) => {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { [VERSION_META]: MODERN_VERSION } },
    };
    const { status, body } = await post(url, headers("tools/list"), payload);
    assert.equal(status, 400);
    assert.equal(body.error.code, -32602);
  });
});

test("unknown methods are 404 with -32601; malformed JSON is 400 with -32700", async () => {
  await withServer(async (url) => {
    const unknown = await post(url, headers("no/such/method"), request("no/such/method"));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, -32601);

    const bad = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json() as any).error.code, -32700);
  });
});

test("notifications answer 202 with no body; batches are rejected in 2026 mode", async () => {
  await withServer(async (url) => {
    const note = await fetch(url, {
      method: "POST",
      headers: headers("notifications/initialized"),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(note.status, 202);
    assert.equal(await note.text(), "");

    const batch = await post(url, headers("tools/list"), [request("tools/list")]);
    assert.equal(batch.status, 400);
    assert.equal(batch.body.error.code, -32600);
  });
});

test("GET and DELETE are 405; sessions are never minted", async () => {
  await withServer(async (url) => {
    const get = await fetch(url, { method: "GET" });
    assert.equal(get.status, 405);
    const del = await fetch(url, { method: "DELETE" });
    assert.equal(del.status, 405);
  });
});

test("Origin validation blocks DNS-rebinding origins", async () => {
  await withServer(async (url) => {
    const evil = await fetch(url, {
      method: "POST",
      headers: { ...headers("tools/list"), Origin: "https://evil.example" },
      body: JSON.stringify(request("tools/list")),
    });
    assert.equal(evil.status, 403);

    const local = await fetch(url, {
      method: "POST",
      headers: { ...headers("tools/list"), Origin: "http://localhost:5173" },
      body: JSON.stringify(request("tools/list")),
    });
    assert.equal(local.status, 200);
  });
});

test("legacy clients negotiate initialize over HTTP without sessions", async () => {
  await withServer(async (url) => {
    const init = await post(
      url,
      { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } },
    );
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.equal(init.res.headers.get("mcp-session-id"), null);

    const list = await post(url, { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" }, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    assert.equal(list.status, 200);
    assert.equal(list.body.result.tools.length, 2);
  });
});

test("headerless requests are rejected with -32020 (except the legacy initialize handshake)", async () => {
  await withServer(async (url) => {
    const bare = await post(url, { "Content-Type": "application/json" }, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal(bare.status, 400);
    assert.equal(bare.body.error.code, -32020);

    const init = await post(
      url,
      { "Content-Type": "application/json" },
      { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } },
    );
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
  });
});

test("non-JSON Content-Type is rejected with 415", async () => {
  await withServer(async (url) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "MCP-Protocol-Version": MODERN_VERSION },
      body: JSON.stringify(request("tools/list")),
    });
    assert.equal(res.status, 415);
  });
});

test("2026-07-28 removed session methods (ping, logging/setLevel) are -32601", async () => {
  await withServer(async (url) => {
    const ping = await post(url, headers("ping"), request("ping"));
    assert.equal(ping.status, 404);
    assert.equal(ping.body.error.code, -32601);

    const setLevel = await post(url, headers("logging/setLevel"), request("logging/setLevel", { level: "debug" }));
    assert.equal(setLevel.status, 404);
    assert.equal(setLevel.body.error.code, -32601);
  });
});

test("malformed JSON-RPC envelopes are -32600, not notifications", async () => {
  await withServer(async (url) => {
    const noMethod = await post(url, headers("tools/list"), { jsonrpc: "2.0", id: 9 });
    assert.equal(noMethod.status, 400);
    assert.equal(noMethod.body.error.code, -32600);
    assert.equal(noMethod.body.id, 9);

    const badVersionField = await post(url, headers("tools/list"), { jsonrpc: "1.0", id: 10, method: "tools/list", params: {} });
    assert.equal(badVersionField.status, 400);
    assert.equal(badVersionField.body.error.code, -32600);
  });
});

test("bearer token auth guards the endpoint when configured", async () => {
  await withServer(
    async (url) => {
      const noAuth = await fetch(url, { method: "POST", headers: headers("tools/list"), body: JSON.stringify(request("tools/list")) });
      assert.equal(noAuth.status, 401);
      const challenge = noAuth.headers.get("www-authenticate") ?? "";
      assert.ok(challenge.includes("resource_metadata="), challenge);

      const wrong = await fetch(url, { method: "POST", headers: { ...headers("tools/list"), Authorization: "Bearer nope" }, body: JSON.stringify(request("tools/list")) });
      assert.equal(wrong.status, 401);

      const ok = await fetch(url, { method: "POST", headers: { ...headers("tools/list"), Authorization: "Bearer s3kr3t" }, body: JSON.stringify(request("tools/list")) });
      assert.equal(ok.status, 200);
    },
    { token: "s3kr3t" },
  );
});

test("protected resource metadata is served unauthenticated (RFC 9728)", async () => {
  await withServer(
    async (url) => {
      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const res = await fetch(new URL(path, url));
        assert.equal(res.status, 200, path);
        const body = (await res.json()) as { resource?: string; bearer_methods_supported?: string[]; authorization_servers?: string[] };
        assert.ok(body.resource?.endsWith("/mcp"), JSON.stringify(body));
        assert.deepEqual(body.authorization_servers, []);
        assert.deepEqual(body.bearer_methods_supported, ["header"]);
      }
    },
    { token: "s3kr3t" },
  );
});

test("oversized schema-constrained arguments are -32602, not tool errors", async () => {
  await withServer(
    async (url) => {
      const { status, body } = await post(
        url,
        headers("tools/call", "echo"),
        request("tools/call", { name: "echo", arguments: { text: "x".repeat(5000) } }),
      );
      assert.equal(status, 400);
      assert.equal(body.error.code, -32602);
      assert.match(body.error.message, /maxLength 4096/);
    },
    { rateLimit: false },
  );
});

test("tools/call bursts are rate-limited with 429 + Retry-After", async () => {
  await withServer(
    async (url) => {
      const call = () =>
        fetch(url, {
          method: "POST",
          headers: headers("tools/call", "echo"),
          body: JSON.stringify(request("tools/call", { name: "echo", arguments: { text: "hi" } })),
        });
      for (let i = 0; i < 3; i++) {
        const ok = await call();
        assert.equal(ok.status, 200, `call ${i} should pass`);
      }
      const limited = await call();
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "1");
    },
    { rateLimit: { burst: 3, perSecond: 0.001 } },
  );
});

test("oversized bodies are rejected with 413", async () => {
  await withServer(async (url) => {
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(4 * 1024 * 1024 + 64) } });
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: huge });
    assert.equal(res.status, 413);
  });
});
