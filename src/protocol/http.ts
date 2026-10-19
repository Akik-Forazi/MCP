/**
 * Streamable HTTP transport for CoreServer (protocol revision 2026-07-28 shape).
 *
 *   POST /mcp   — one JSON-RPC request or notification per POST; replies are
 *                 a single JSON object (SSE is never required of servers).
 *   GET/DELETE  — 405 Method Not Allowed (no standalone stream, no sessions).
 *
 * Security defaults: binds 127.0.0.1 unless told otherwise, always validates
 * the Origin header (403 on cross-origin/DNS-rebinding attempts), never mints
 * or echoes Mcp-Session-Id, and supports optional bearer-token auth.
 *
 * No dependencies: node:http only.
 */

import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { CoreServer, HttpMeta } from "./server.ts";

export interface HttpServeOptions {
  server: CoreServer;
  /** 0 = ephemeral port (tests). Default 7777. */
  port?: number;
  /** Default 127.0.0.1. Non-loopback binds are allowed but discouraged. */
  host?: string;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** Extra exact Origin values to allow beyond loopback. */
  allowOrigins?: string[];
  /**
   * Per-client `tools/call` token bucket (DoS guard). `burst` tokens refilled
   * at `perSecond`; exceeding → 429 + Retry-After. Default { burst: 30, perSecond: 15 }.
   * `false` disables (stdio transport is never rate-limited).
   */
  rateLimit?: { burst: number; perSecond: number } | false;
  log?: (line: string) => void;
}

export interface HttpServeHandle {
  port: number;
  url: string;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const PRM_PATH = "/.well-known/oauth-protected-resource";

function headerString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function originAllowed(origin: string, extra: string[]): boolean {
  if (extra.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function rpcError(code: number, message: string, id: unknown = null): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function readBody(req: IncomingMessage): Promise<string | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        resolve("too-large");
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    req.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

function idsOf(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed.map(idsOf).flat();
  if (parsed && typeof parsed === "object") {
    const id = (parsed as { id?: unknown }).id;
    if (id !== undefined && id !== null) return [id];
  }
  return [];
}

function hasMethod(parsed: unknown, method: string): boolean {
  if (Array.isArray(parsed)) return parsed.some((m) => hasMethod(m, method));
  return Boolean(parsed && typeof parsed === "object" && (parsed as { method?: unknown }).method === method);
}

export async function serveHttp(opts: HttpServeOptions): Promise<HttpServeHandle> {
  const { server, port = 7777, host = "127.0.0.1", token } = opts;
  const allowOrigins = opts.allowOrigins ?? [];
  const rateLimit = opts.rateLimit === undefined ? { burst: 30, perSecond: 15 } : opts.rateLimit;
  const buckets = new Map<string, { tokens: number; last: number }>();
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((e: unknown) => {
      log(`[fraziym-mcp] http error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "Internal error"));
      else res.end();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 1. Origin validation (DNS-rebinding protection) — all methods.
    const origin = headerString(req.headers.origin);
    if (origin !== undefined && !originAllowed(origin, allowOrigins)) {
      sendJson(res, 403, rpcError(-32600, "Forbidden: invalid Origin"));
      return;
    }

    // 2. Optional bearer token.
    if (token !== undefined) {
      // RFC 9728 Protected Resource Metadata is served unauthenticated so
      // clients can discover how to authenticate.
      const pathname = (req.url ?? "").split("?")[0] ?? "";
      if (req.method === "GET" && (pathname === PRM_PATH || pathname.startsWith(`${PRM_PATH}/`))) {
        const base = `http://${headerString(req.headers.host) ?? `${host}:${actualPort ?? port}`}`;
        sendJson(res, 200, {
          resource: `${base}/mcp`,
          authorization_servers: [],
          bearer_methods_supported: ["header"],
          resource_documentation: "https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization",
        });
        return;
      }

      const auth = headerString(req.headers.authorization) ?? "";
      const expected = `Bearer ${token}`;
      const a = Buffer.from(auth);
      const b = Buffer.from(expected);
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (!ok) {
        const base = `http://${headerString(req.headers.host) ?? `${host}:${actualPort ?? port}`}`;
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${base}${PRM_PATH}"`,
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(rpcError(-32020, "Unauthorized")));
        return;
      }
    }

    // 3. POST only: no standalone SSE stream, no sessions.
    if (req.method === "OPTIONS") {
      res.writeHead(204, { Allow: "POST" });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, rpcError(-32601, "Method Not Allowed: use POST"));
      return;
    }

    // 4. JSON content type is mandatory for the message body.
    const contentType = headerString(req.headers["content-type"]);
    const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      sendJson(res, 415, rpcError(-32600, "Unsupported Media Type: Content-Type must be application/json"));
      return;
    }

    const body = await readBody(req);
    if (body === "too-large") {
      sendJson(res, 413, rpcError(-32600, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, rpcError(-32700, "Parse error"));
      return;
    }

    // Per-client rate limit for tool invocations (notification-safe: checked
    // before dispatch so a burst cannot schedule work).
    if (rateLimit !== false && hasMethod(parsed, "tools/call")) {
      const client = req.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      let bucket = buckets.get(client);
      if (!bucket) {
        bucket = { tokens: rateLimit.burst, last: now };
        buckets.set(client, bucket);
      }
      bucket.tokens = Math.min(rateLimit.burst, bucket.tokens + ((now - bucket.last) / 1000) * rateLimit.perSecond);
      bucket.last = now;
      if (bucket.tokens < 1) {
        res.writeHead(429, {
          "Retry-After": "1",
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(rpcError(-32000, "Rate limit exceeded: too many tools/call requests")));
        return;
      }
      bucket.tokens -= 1;
    }

    // Client disconnect before the response completes cancels the work.
    res.on("close", () => {
      if (!res.writableFinished) {
        for (const id of idsOf(parsed)) server.cancelById(id);
      }
    });

    const httpMeta: HttpMeta = {
      protocolVersion: headerString(req.headers["mcp-protocol-version"]),
      mcpMethod: headerString(req.headers["mcp-method"]),
      mcpName: headerString(req.headers["mcp-name"]),
    };

    const outcome = await server.process(parsed, { http: httpMeta });
    if (outcome.response === null) {
      res.writeHead(outcome.httpStatus);
      res.end();
      return;
    }
    sendJson(res, outcome.httpStatus, outcome.response);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });

  const address = httpServer.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  const url = `http://${host}:${actualPort}/mcp`;

  return {
    port: actualPort,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      }),
  };
}
