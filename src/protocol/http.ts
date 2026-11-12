/**
 * Streamable HTTP transport for CoreServer.
 *
 *   POST /mcp   — one JSON-RPC message per POST. Modern (2026-07-28) requests
 *                 are always answered with a single JSON object. Legacy
 *                 requests (2025-03-26…) that accept `text/event-stream` are
 *                 answered with an SSE stream: notifications/requests ride the
 *                 stream, then the JSON-RPC reply event closes it.
 *   GET /mcp    — standalone SSE stream for legacy sessions; a GET carrying
 *                 `Last-Event-ID` resumes a closed stream and replays the
 *                 buffered events after that id (SEP-1699 polling).
 *   DELETE /mcp — terminates a legacy session (200) when one is provided.
 *
 * Legacy initialize mints `Mcp-Session-Id`; modern stays stateless (GET and
 * DELETE without a session are 405, no session is ever minted).
 *
 * Security defaults: binds 127.0.0.1 unless told otherwise, always validates
 * the Origin header (403 on cross-origin/DNS-rebinding attempts), and supports
 * optional bearer-token auth.
 *
 * No dependencies: node:http only.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { CoreServer, HttpMeta, TransportHooks } from "./server.ts";
import { MODERN_VERSION } from "./server.ts";

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
const SSE_RETRY_MS = 1000;
const MAX_BUFFERED_EVENTS = 500;
const MAX_SESSIONS = 128;
const STREAM_GC_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 25_000;

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

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
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

function isSingleRequest(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const msg = parsed as { method?: unknown; id?: unknown };
  return typeof msg.method === "string" && msg.id !== undefined && msg.id !== null;
}

interface BufferedEvent {
  id: number;
  data: string;
  retry?: number;
}

interface HttpSession {
  id: string;
  createdAt: number;
  streams: Set<SseStream>;
  standalone?: SseStream;
}

/**
 * One SSE stream (a POST response stream or a standalone GET stream) with a
 * bounded replay buffer keyed by monotonically increasing event ids.
 */
class SseStream {
  private res: ServerResponse | undefined;
  private readonly events: BufferedEvent[] = [];
  private completed = false;
  private ended = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private gcTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly idOfEvent: () => number;
  private readonly registerEvent: (id: number, stream: SseStream) => void;
  private readonly unregisterEvent: (ids: number[]) => void;
  private readonly session: HttpSession | undefined;

  constructor(
    idOfEvent: () => number,
    registerEvent: (id: number, stream: SseStream) => void,
    unregisterEvent: (ids: number[]) => void,
    session?: HttpSession,
  ) {
    this.idOfEvent = idOfEvent;
    this.registerEvent = registerEvent;
    this.unregisterEvent = unregisterEvent;
    this.session = session;
    session?.streams.add(this);
  }

  get isCompleted(): boolean {
    return this.completed;
  }

  get hasConnection(): boolean {
    return this.res !== undefined && !this.ended;
  }

  /** Bind an HTTP response and write SSE headers. */
  attach(res: ServerResponse, extraHeaders: Record<string, string> = {}): void {
    this.res = res;
    this.ended = false;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...extraHeaders,
    });
    res.flushHeaders();
    res.on("close", () => this.detach(res));
  }

  detach(res: ServerResponse): void {
    if (this.res === res) this.res = undefined;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /** Start keepalive comments (standalone streams only). */
  startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      try {
        this.res?.write(": ping\n\n");
      } catch {
        // connection died; detach happens via the close handler
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private frame(event: BufferedEvent): string {
    let out = `id: ${event.id}\n`;
    if (event.retry !== undefined) out += `retry: ${event.retry}\n`;
    for (const line of event.data.split("\n")) out += `data: ${line}\n`;
    return `${out}\n`;
  }

  writeEvent(event: BufferedEvent): void {
    if (this.completed) return;
    this.events.push(event);
    if (this.events.length > MAX_BUFFERED_EVENTS) this.events.shift();
    this.registerEvent(event.id, this);
    if (this.res && !this.ended) {
      try {
        this.res.write(this.frame(event));
      } catch {
        this.detach(this.res);
      }
    }
  }

  /** Write a JSON-RPC message as an SSE event with a fresh id. */
  writeMessage(message: unknown): void {
    this.writeEvent({ id: this.idOfEvent(), data: JSON.stringify(message) });
  }

  /**
   * SEP-1699 priming event: id + empty data + retry, then close the response
   * connection so the client resumes with `Last-Event-ID`.
   */
  primeAndClose(): void {
    if (this.ended) return;
    this.writeEvent({ id: this.idOfEvent(), data: "", retry: SSE_RETRY_MS });
    this.endConnection();
  }

  /** End the attached connection (if any). Buffered events survive for replay. */
  endConnection(): void {
    if (this.res && !this.ended) {
      this.ended = true;
      try {
        this.res.end();
      } catch {
        // already gone
      }
      this.res = undefined;
    }
  }

  /** No further events will be produced for this stream. */
  complete(): void {
    this.completed = true;
    this.endConnection();
    this.scheduleGc();
  }

  /** Replay events after `lastEventId` onto a resumed GET response. */
  resume(res: ServerResponse, lastEventId: number, extraHeaders: Record<string, string> = {}): void {
    this.attach(res, extraHeaders);
    for (const event of this.events) {
      if (event.id > lastEventId) {
        try {
          res.write(this.frame(event));
        } catch {
          this.detach(res);
          return;
        }
      }
    }
    if (this.completed) {
      this.detach(res);
      res.end();
    }
  }

  /** Force-close (session delete / server shutdown); drops buffered events. */
  forceClose(): void {
    this.completed = true;
    this.endConnection();
    this.dispose();
  }

  private scheduleGc(): void {
    this.gcTimer ??= setTimeout(() => this.dispose(), STREAM_GC_MS);
    this.gcTimer.unref?.();
  }

  private dispose(): void {
    this.session?.streams.delete(this);
    if (this.session?.standalone === this) delete this.session.standalone;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.unregisterEvent(this.events.map((e) => e.id));
    this.events.length = 0;
  }
}

export async function serveHttp(opts: HttpServeOptions): Promise<HttpServeHandle> {
  const { server, port = 7777, host = "127.0.0.1", token } = opts;
  const allowOrigins = opts.allowOrigins ?? [];
  const rateLimit = opts.rateLimit === undefined ? { burst: 30, perSecond: 15 } : opts.rateLimit;
  const buckets = new Map<string, { tokens: number; last: number }>();
  const log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));

  const sessions = new Map<string, HttpSession>();
  const eventIndex = new Map<number, SseStream>();
  let eventSeq = 0;

  const newStream = (session?: HttpSession): SseStream =>
    new SseStream(
      () => ++eventSeq,
      (id, stream) => eventIndex.set(id, stream),
      (ids) => {
        for (const id of ids) eventIndex.delete(id);
      },
      session,
    );

  const pruneSessions = (): void => {
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.values().next().value;
      if (!oldest) break;
      for (const stream of oldest.streams) stream.forceClose();
      sessions.delete(oldest.id);
    }
  };

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

    if (req.method === "OPTIONS") {
      res.writeHead(204, { Allow: "POST, GET, DELETE" });
      res.end();
      return;
    }

    const version = headerString(req.headers["mcp-protocol-version"]);
    const isModern = version === MODERN_VERSION;
    const sessionIdHeader = headerString(req.headers["mcp-session-id"]);
    const session = sessionIdHeader ? sessions.get(sessionIdHeader) : undefined;

    // 3. GET — standalone SSE stream / Last-Event-ID resumption (legacy only).
    if (req.method === "GET") {
      const accept = headerString(req.headers.accept) ?? "";
      if (isModern || !accept.includes("text/event-stream")) {
        sendJson(res, 405, rpcError(-32601, "Method Not Allowed: use POST"));
        return;
      }

      const lastEventId = headerString(req.headers["last-event-id"]);
      if (lastEventId !== undefined && lastEventId !== "") {
        const stream = eventIndex.get(Number(lastEventId));
        if (!stream) {
          sendJson(res, 400, rpcError(-32602, `Unknown Last-Event-ID: ${lastEventId}`));
          return;
        }
        stream.resume(res, Number(lastEventId));
        return;
      }

      if (!session) {
        sendJson(res, 405, rpcError(-32601, "Method Not Allowed: provide Mcp-Session-Id or Last-Event-ID"));
        return;
      }
      let standalone = session.standalone;
      if (!standalone || standalone.isCompleted) {
        standalone = newStream(session);
        session.standalone = standalone;
      }
      standalone.attach(res);
      standalone.startHeartbeat();
      return;
    }

    // 4. DELETE — terminate a legacy session.
    if (req.method === "DELETE") {
      if (isModern || !session) {
        sendJson(res, 405, rpcError(-32601, "Method Not Allowed: no session to delete"));
        return;
      }
      for (const stream of [...session.streams]) stream.forceClose();
      sessions.delete(session.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, rpcError(-32601, "Method Not Allowed: use POST"));
      return;
    }

    // 5. JSON content type is mandatory for the message body.
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

    // Unknown legacy session ids are 404 so clients re-initialize.
    if (!isModern && sessionIdHeader !== undefined && !session) {
      sendJson(res, 404, rpcError(-32001, "Session not found: reinitialize"));
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

    // Legacy initialize mints a session (modern 2026-07-28 is stateless).
    let mintedSession: HttpSession | undefined;
    if (!isModern && hasMethod(parsed, "initialize")) {
      const existing = session;
      if (existing) {
        mintedSession = existing;
      } else {
        mintedSession = {
          id: randomUUID(),
          createdAt: Date.now(),
          streams: new Set(),
        };
        sessions.set(mintedSession.id, mintedSession);
        pruneSessions();
      }
    }
    const activeSession = session ?? mintedSession;
    const extraHeaders: Record<string, string> = activeSession
      ? { "Mcp-Session-Id": activeSession.id }
      : {};

    const httpMeta: HttpMeta = {
      protocolVersion: version,
      mcpMethod: headerString(req.headers["mcp-method"]),
      mcpName: headerString(req.headers["mcp-name"]),
    };

    // 6. SSE response path: legacy single requests that accept event-stream.
    const accept = headerString(req.headers.accept) ?? "";
    if (!isModern && accept.includes("text/event-stream") && isSingleRequest(parsed)) {
      const stream = newStream(activeSession);
      let intentionalClose = false;
      const hooks: TransportHooks = {
        send: (message) => stream.writeMessage(message),
        closeStream: () => {
          intentionalClose = true;
          stream.primeAndClose();
        },
      };
      stream.attach(res, extraHeaders);

      res.on("close", () => {
        if (!intentionalClose && !stream.isCompleted) {
          for (const id of idsOf(parsed)) server.cancelById(id);
        }
      });

      const outcome = await server.process(parsed, { http: httpMeta, hooks });
      if (outcome.response !== null) stream.writeMessage(outcome.response);
      stream.complete();
      return;
    }

    // 7. Plain JSON path (modern + legacy clients that don't want SSE).
    res.on("close", () => {
      if (!res.writableFinished) {
        for (const id of idsOf(parsed)) server.cancelById(id);
      }
    });

    const outcome = await server.process(parsed, { http: httpMeta });
    if (outcome.response === null) {
      res.writeHead(outcome.httpStatus, extraHeaders);
      res.end();
      return;
    }
    sendJson(res, outcome.httpStatus, outcome.response, extraHeaders);
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
        for (const session of sessions.values()) {
          for (const stream of [...session.streams]) stream.forceClose();
        }
        sessions.clear();
        httpServer.close(() => resolve());
        httpServer.closeAllConnections?.();
      }),
  };
}
