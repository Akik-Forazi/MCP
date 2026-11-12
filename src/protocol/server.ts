/**
 * Core protocol server — transport-agnostic MCP (JSON-RPC 2.0) dispatch.
 *
 * Dual-era by design:
 *   - Legacy  (2024-11-05 → 2025-11-25): `initialize` handshake on stdio.
 *   - Modern  (2026-07-28): stateless per-request `_meta`, `server/discover`,
 *     `resultType` on every result, `ttlMs`/`cacheScope` on list results,
 *     `-32020` HeaderMismatch / `-32022` UnsupportedProtocolVersion over HTTP.
 *
 * The stdio shell (`handleLine`) and the HTTP transport (`process` with a
 * `http` context) both feed raw messages in; HTTP maps the returned status.
 */

import type { McpContentBlock, ToolCallContext, ToolFunctionSchema, ToolResult } from "../core/types.ts";
import {
  PromptArgumentError,
  PromptNotFoundError,
  ResourceNotFoundError,
  type CompletionResult,
  type GetPromptResult,
  type PromptDef,
  type ResourceContents,
  type ResourceDef,
  type ResourceTemplateDef,
} from "../core/features.ts";

export interface ToolHostLike {
  names(): string[];
  specs(): ToolFunctionSchema[];
  /** Optional richer MCP tool definitions (annotations etc.). */
  definitions?(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, boolean>;
  }>;
  call(name: string, args: Record<string, unknown>, ctx?: ToolCallContext): Promise<ToolResult>;
  /** Optional resources/prompts/completion surface (advertised when present). */
  listResources?(): ResourceDef[];
  listResourceTemplates?(): ResourceTemplateDef[];
  readResource?(uri: string): ResourceContents;
  listPrompts?(): PromptDef[];
  getPrompt?(name: string, args: Record<string, string>): GetPromptResult;
  complete?(
    ref: { type?: unknown; name?: unknown; uri?: unknown },
    argument: { name?: unknown; value?: unknown },
  ): CompletionResult;
}

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS] as const;
export const LATEST_VERSION = MODERN_VERSION;
export const LATEST_LEGACY_VERSION = "2025-06-18";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const LIST_TTL_MS = 600_000;
const CACHE_SCOPE = "public";
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpMeta {
  /** `MCP-Protocol-Version` header (undefined when the client omitted it). */
  protocolVersion?: string;
  /** `Mcp-Method` header. */
  mcpMethod?: string;
  /** `Mcp-Name` header (raw; may use the `=?base64?...?=` sentinel). */
  mcpName?: string;
}

/** Transport hooks for outbound traffic (notifications + server→client requests). */
export interface TransportHooks {
  /** Send a raw JSON-RPC message to the client (notification or request). */
  send(message: unknown): void;
  /** Close the current response stream mid-call (SSE streams; noop on stdio). */
  closeStream?(): void;
}

export interface ProcessContext {
  /** Present when the carrier is the Streamable HTTP transport. */
  http?: HttpMeta;
  /** Per-request outbound hooks (SSE stream / stdio writer). */
  hooks?: TransportHooks;
}

export interface ProcessOutcome {
  /** JSON-RPC response object to send back, or null (notification / cancelled). */
  response: unknown | null;
  /** HTTP status the transport should use (ignored by stdio). */
  httpStatus: number;
}

export interface CoreServerOptions {
  host: ToolHostLike;
  serverName?: string;
  version: string;
  instructions?: string;
  /** Called for server-side log lines (never stdout in stdio mode). */
  log?: (line: string) => void;
  /** stdio transport writer (server→client notifications/requests). */
  send?: (message: unknown) => void;
}

const LOG_LEVELS = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];

interface PendingOutbound {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

const BASE64_SENTINEL_RE = /^=\?base64\?(.*)\?=$/;

const INSTRUCTIONS =
  "Fraziym MCP toolbelt. Workspace-confined tools; every call is guarded " +
  "(path jail, argument caps, output truncation, audit). Use file_* to work " +
  "on files, git_* for version control, axodex_* for code-graph intelligence, " +
  "web_* to reach the internet, and get_time for dates. Tool results are plain " +
  "text; errors start with [ERROR].";

/** Decode the `=?base64?…?=` sentinel used for non-ASCII header values. */
export function decodeHeaderValue(raw: string): string {
  const m = BASE64_SENTINEL_RE.exec(raw);
  if (!m) return raw;
  return Buffer.from(m[1] ?? "", "base64").toString("utf8");
}

function isSupportedVersion(version: string): boolean {
  return (SUPPORTED_VERSIONS as readonly string[]).includes(version);
}

function isLegacyVersion(version: string): boolean {
  return (LEGACY_VERSIONS as readonly string[]).includes(version);
}

export class CoreServer {
  private readonly host: ToolHostLike;
  private readonly version: string;
  private readonly serverName: string;
  private readonly instructions: string;
  private readonly log: (line: string) => void;

  private readonly send: ((message: unknown) => void) | undefined;

  private negotiatedVersion: string = LATEST_LEGACY_VERSION;
  private logLevel: LogLevel = "info";
  private readonly inflight = new Map<string, { cancelled: boolean }>();
  private readonly subscriptions = new Set<string>();

  /** Client capabilities (legacy: from initialize; modern: from per-request _meta). */
  private clientCaps: Record<string, unknown> = {};
  private outboundSeq = 0;
  private readonly pending = new Map<string, PendingOutbound>();

  constructor(opts: CoreServerOptions) {
    this.host = opts.host;
    this.version = opts.version;
    this.serverName = opts.serverName ?? "fraziym-mcp";
    this.instructions = opts.instructions ?? INSTRUCTIONS;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.send = opts.send;
  }

  /** Legacy-negotiated version (stdio connections); informational only. */
  get protocolVersion(): string {
    return this.negotiatedVersion;
  }

  /** Currently negotiated log level (kept for parity/debug). */
  get level(): string {
    return this.logLevel;
  }

  /** stdio shell: handle one raw JSON line, return the JSON to write (or null). */
  async handleLine(line: string): Promise<string | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }
    const hooks: TransportHooks | undefined = this.send
      ? { send: (message) => this.send?.(message) }
      : undefined;
    const outcome = await this.process(parsed, hooks ? { hooks } : {});
    return outcome.response === null ? null : JSON.stringify(outcome.response);
  }

  /** Test/embedding convenience: the response object (or null). */
  async handleMessage(msg: unknown): Promise<unknown | null> {
    return (await this.process(msg)).response;
  }

  /** Mark a request (by JSON-RPC id) as cancelled; its response is dropped. */
  cancelById(id: unknown): void {
    if (id === undefined || id === null) return;
    const entry = this.inflight.get(JSON.stringify(id));
    if (entry) entry.cancelled = true;
  }

  /** Dispatch a parsed message (or legacy batch) with transport metadata. */
  async process(msg: unknown, ctx: ProcessContext = {}): Promise<ProcessOutcome> {
    const http = ctx.http;
    if (http) {
      if (http.protocolVersion === undefined) {
        // Headerless requests: only `initialize` (legacy handshake) is allowed;
        // everything else fails Server Validation (-32020).
        if (methodOf(msg) !== "initialize") {
          return {
            response: {
              jsonrpc: "2.0",
              id: idOf(msg),
              error: {
                code: -32020,
                message: "Header mismatch: required header MCP-Protocol-Version is missing",
              },
            },
            httpStatus: 400,
          };
        }
      } else if (!isSupportedVersion(http.protocolVersion)) {
        return {
          response: {
            jsonrpc: "2.0",
            id: idOf(msg),
            error: {
              code: -32022,
              message: "Unsupported protocol version",
              data: { supported: [...SUPPORTED_VERSIONS], requested: http.protocolVersion },
            },
          },
          httpStatus: 400,
        };
      }
    }

    if (Array.isArray(msg)) {
      if (http?.protocolVersion === MODERN_VERSION) {
        return {
          response: {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request: batches are not part of 2026-07-28" },
          },
          httpStatus: 400,
        };
      }
      if (msg.length === 0) {
        return errOutcome(null, -32600, "Invalid Request", undefined, 400);
      }
      const outcomes = await Promise.all(msg.map((m) => this.processOne(m, ctx)));
      const responses = outcomes.map((o) => o.response).filter((r) => r !== null);
      return { response: responses.length > 0 ? responses : null, httpStatus: 200 };
    }

    return this.processOne(msg, ctx);
  }

  private async processOne(msg: unknown, ctx: ProcessContext): Promise<ProcessOutcome> {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      return errOutcome(null, -32600, "Invalid Request", undefined, 400);
    }
    const req = msg as JsonRpcMessage;
    if (typeof req.method !== "string") {
      // A message without `method` may be a JSON-RPC *response* to a
      // server→client request (sampling/createMessage, elicitation/create).
      if (req.jsonrpc === "2.0" && req.id !== undefined && req.id !== null && this.resolveOutbound(req)) {
        return { response: null, httpStatus: 202 };
      }
      return errOutcome(req.id ?? null, -32600, "Invalid Request", undefined, 400);
    }
    if (req.jsonrpc !== "2.0") {
      return errOutcome(req.id ?? null, -32600, "Invalid Request", undefined, 400);
    }
    const isNotification = req.id === undefined || req.id === null;

    if (isNotification) {
      // Notifications carry no response; HTTP answers 202 Accepted.
      await this.dispatch(req, this.eraOf(req, ctx), ctx);
      return { response: null, httpStatus: 202 };
    }

    if (ctx.http?.protocolVersion === MODERN_VERSION) {
      const violation = this.validateModernRequest(req, ctx.http);
      if (violation) return violation;
    }

    const era = this.eraOf(req, ctx);
    const response = await this.dispatch(req, era, ctx);
    return { response, httpStatus: statusFor(response) };
  }

  /** Resolve a pending server→client request from an inbound JSON-RPC response. */
  private resolveOutbound(msg: JsonRpcMessage & { result?: unknown; error?: { message?: string } }): boolean {
    const key = String(msg.id);
    if (!key.startsWith("srv-")) return false;
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.pending.delete(key);
    clearTimeout(entry.timeout);
    if (msg.error) entry.reject(new Error(msg.error.message ?? "client error"));
    else entry.resolve(msg.result);
    return true;
  }

  /** Send a server→client request (sampling/elicitation) and await its result. */
  async requestClient(
    method: string,
    params: Record<string, unknown>,
    hooks?: TransportHooks,
    timeoutMs = 120000,
  ): Promise<unknown> {
    if (!hooks) throw new Error(`transport cannot carry server→client request ${method}`);
    const id = `srv-${++this.outboundSeq}`;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`client did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      hooks.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Modern-era requests get resultType/ttlMs/_meta; legacy stays schema-clean. */
  private eraOf(req: JsonRpcMessage, ctx: ProcessContext): "modern" | "legacy" {
    if (ctx.http) return ctx.http.protocolVersion === MODERN_VERSION ? "modern" : "legacy";
    return typeof metaOf(req.params)[META_VERSION] === "string" ? "modern" : "legacy";
  }

  /** Streamable HTTP header ↔ body validation for 2026-07-28 requests. */
  private validateModernRequest(req: JsonRpcMessage, http: HttpMeta): ProcessOutcome | null {
    const id = req.id;
    const bodyMeta = metaOf(req.params);
    const mismatch = (message: string): ProcessOutcome =>
      errOutcome(id, -32020, message, undefined, 400);

    const bodyVersion = bodyMeta[META_VERSION];
    const caps = bodyMeta[META_CLIENT_CAPS];
    const missing: string[] = [];
    if (typeof bodyVersion !== "string") missing.push(`_meta['${META_VERSION}']`);
    if (caps === undefined || caps === null || typeof caps !== "object") {
      missing.push(`_meta['${META_CLIENT_CAPS}']`);
    }
    if (missing.length > 0) {
      return errOutcome(
        id,
        -32602,
        `Invalid params: missing required ${missing.join(", ")}`,
        undefined,
        400,
      );
    }

    if (bodyVersion !== http.protocolVersion) {
      return mismatch(
        `Header mismatch: MCP-Protocol-Version '${String(http.protocolVersion)}' does not match ` +
          `body _meta '${META_VERSION}' ('${String(bodyVersion)}')`,
      );
    }

    if (http.mcpMethod === undefined) {
      return mismatch("Header mismatch: required header Mcp-Method is missing");
    }
    if (http.mcpMethod !== req.method) {
      return mismatch(
        `Header mismatch: Mcp-Method '${http.mcpMethod}' does not match body method '${String(req.method)}'`,
      );
    }

    const nameField =
      req.method === "tools/call" || req.method === "prompts/get"
        ? "name"
        : req.method === "resources/read"
          ? "uri"
          : undefined;
    if (nameField) {
      const bodyValue = req.params?.[nameField];
      if (http.mcpName === undefined) {
        return mismatch(`Header mismatch: required header Mcp-Name is missing for ${req.method}`);
      }
      const decoded = decodeHeaderValue(http.mcpName);
      if (typeof bodyValue !== "string" || decoded !== bodyValue) {
        return mismatch(
          `Header mismatch: Mcp-Name '${decoded}' does not match body value '${String(bodyValue)}'`,
        );
      }
    }

    return null;
  }

  private async dispatch(
    req: JsonRpcMessage,
    era: "modern" | "legacy",
    ctx: ProcessContext = {},
  ): Promise<unknown | null> {
    const { id, method } = req;
    const params = req.params ?? {};
    const isNotification = id === undefined || id === null;
    const reply = (result: Record<string, unknown>): unknown | null => {
      if (isNotification) return null;
      const body =
        era === "modern"
          ? { resultType: "complete", ...result, _meta: this.serverMeta() }
          : result;
      return { jsonrpc: "2.0", id, result: body };
    };
    const fail = (code: number, message: string, data?: unknown): unknown | null =>
      isNotification ? null : { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };

    // stdio path only: a request carrying modern _meta is validated here
    // (HTTP requests were already validated against the mirrored headers).
    if (era === "modern") {
      const meta = metaOf(params);
      const declared = meta[META_VERSION];
      if (typeof declared === "string") {
        if (!isSupportedVersion(declared)) {
          return fail(-32022, "Unsupported protocol version", {
            supported: [...SUPPORTED_VERSIONS],
            requested: declared,
          });
        }
        const caps = meta[META_CLIENT_CAPS];
        if (caps === undefined || caps === null || typeof caps !== "object") {
          return fail(-32602, `Invalid params: _meta['${META_CLIENT_CAPS}'] is required on every request`);
        }
      }
    }

    // 2026-07-28 removed the session-scoped `ping` and `logging/setLevel`;
    // logging level travels per-request via _meta logLevel instead.
    if (era === "modern" && (method === "ping" || method === "logging/setLevel")) {
      return fail(-32601, `Method not found: ${String(method)}`);
    }

    try {
      switch (method) {
        case "initialize": {
          const requested =
            typeof params.protocolVersion === "string" ? params.protocolVersion : LATEST_LEGACY_VERSION;
          this.negotiatedVersion = isLegacyVersion(requested) ? requested : LATEST_LEGACY_VERSION;
          if (params.capabilities && typeof params.capabilities === "object") {
            this.clientCaps = params.capabilities as Record<string, unknown>;
          }
          this.log(
            `[fraziym-mcp] initialize: requested ${requested} → ${this.negotiatedVersion}`,
          );
          return isNotification
            ? null
            : {
                jsonrpc: "2.0",
                id,
                result: {
                  protocolVersion: this.negotiatedVersion,
                  capabilities: this.capabilities(),
                  serverInfo: { name: this.serverName, version: this.version },
                  instructions: this.instructions,
                },
              };
        }

        case "notifications/initialized":
        case "notifications/roots/list_changed":
          return null;

        case "notifications/cancelled": {
          this.cancelById(params.requestId);
          return null;
        }

        case "ping":
          return reply({});

        case "logging/setLevel": {
          if (typeof params.level === "string" && (LOG_LEVELS as readonly string[]).includes(params.level)) {
            this.logLevel = params.level as LogLevel;
          }
          return reply({});
        }

        case "tools/list":
          return reply(
            era === "modern"
              ? { tools: this.listTools(), ttlMs: LIST_TTL_MS, cacheScope: CACHE_SCOPE }
              : { tools: this.listTools() },
          );

        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const args =
            params.arguments && typeof params.arguments === "object"
              ? (params.arguments as Record<string, unknown>)
              : {};
          const violation = this.maxLengthViolation(name, args);
          if (violation !== null) return fail(-32602, `Invalid params: ${violation}`);
          const key = JSON.stringify(id ?? null);
          const slot = { cancelled: false };
          if (!isNotification) this.inflight.set(key, slot);
          try {
            const toolCtx = this.toolContext(params, ctx);
            const result = await this.host.call(name, args, toolCtx);
            if (slot.cancelled) {
              this.log(`[fraziym-mcp] tools/call ${name}: cancelled by client, response dropped`);
              return null;
            }
            if (typeof result === "string") {
              return reply({
                content: [{ type: "text", text: result }],
                isError: result.startsWith("[ERROR]"),
              });
            }
            const content: McpContentBlock[] =
              result.length > 0 ? result : [{ type: "text", text: "" }];
            return reply({ content, isError: false });
          } finally {
            this.inflight.delete(key);
          }
        }

        case "resources/list": {
          if (!this.host.listResources) return fail(-32601, "Method not found: resources/list");
          const resources = this.host.listResources();
          return reply(
            era === "modern"
              ? { resources, ttlMs: LIST_TTL_MS, cacheScope: CACHE_SCOPE }
              : { resources },
          );
        }

        case "resources/templates/list": {
          if (!this.host.listResourceTemplates) {
            return fail(-32601, "Method not found: resources/templates/list");
          }
          const resourceTemplates = this.host.listResourceTemplates();
          return reply(
            era === "modern"
              ? { resourceTemplates, ttlMs: LIST_TTL_MS, cacheScope: CACHE_SCOPE }
              : { resourceTemplates },
          );
        }

        case "resources/read": {
          if (!this.host.readResource) return fail(-32601, "Method not found: resources/read");
          const uri = typeof params.uri === "string" ? params.uri : "";
          if (uri.length === 0) return fail(-32602, "Invalid params: missing required string uri");
          try {
            const contents = this.host.readResource(uri);
            return reply({ contents: [contents] });
          } catch (e) {
            if (e instanceof ResourceNotFoundError) return fail(-32002, `Resource not found: ${uri}`);
            throw e;
          }
        }

        case "resources/subscribe": {
          const uri = typeof params.uri === "string" ? params.uri : "";
          if (uri.length === 0) return fail(-32602, "Invalid params: missing required string uri");
          this.subscriptions.add(uri);
          return reply({});
        }

        case "resources/unsubscribe": {
          const uri = typeof params.uri === "string" ? params.uri : "";
          if (uri.length === 0) return fail(-32602, "Invalid params: missing required string uri");
          this.subscriptions.delete(uri);
          return reply({});
        }

        case "prompts/list": {
          if (!this.host.listPrompts) return fail(-32601, "Method not found: prompts/list");
          const prompts = this.host.listPrompts();
          return reply(
            era === "modern" ? { prompts, ttlMs: LIST_TTL_MS, cacheScope: CACHE_SCOPE } : { prompts },
          );
        }

        case "prompts/get": {
          if (!this.host.getPrompt) return fail(-32601, "Method not found: prompts/get");
          const name = typeof params.name === "string" ? params.name : "";
          if (name.length === 0) return fail(-32602, "Invalid params: missing required string name");
          const args: Record<string, string> = {};
          if (params.arguments && typeof params.arguments === "object") {
            for (const [k, v] of Object.entries(params.arguments as Record<string, unknown>)) {
              if (typeof v === "string") args[k] = v;
            }
          }
          try {
            const prompt = this.host.getPrompt(name, args);
            return reply({ description: prompt.description, messages: prompt.messages });
          } catch (e) {
            if (e instanceof PromptNotFoundError) return fail(-32602, `Unknown prompt: ${name}`);
            if (e instanceof PromptArgumentError) return fail(-32602, `Invalid params: ${e.message}`);
            throw e;
          }
        }

        case "completion/complete": {
          if (!this.host.complete) return fail(-32601, "Method not found: completion/complete");
          const ref =
            params.ref && typeof params.ref === "object"
              ? (params.ref as { type?: unknown; name?: unknown; uri?: unknown })
              : {};
          const argument =
            params.argument && typeof params.argument === "object"
              ? (params.argument as { name?: unknown; value?: unknown })
              : {};
          return reply({ completion: this.host.complete(ref, argument) });
        }

        case "server/discover": {
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              resultType: "complete",
              supportedVersions: [...SUPPORTED_VERSIONS],
              capabilities: this.capabilities(),
              instructions: this.instructions,
              ttlMs: LIST_TTL_MS,
              cacheScope: CACHE_SCOPE,
              _meta: this.serverMeta(),
            },
          };
        }

        default:
          return fail(-32601, `Method not found: ${String(method)}`);
      }
    } catch (e) {
      return fail(-32603, e instanceof Error ? e.message : String(e));
    }
  }

  private listTools(): Array<Record<string, unknown>> {
    if (this.host.definitions) return this.host.definitions();
    return this.host.specs().map((s) => ({
      name: s.function.name,
      description: s.function.description,
      inputSchema: s.function.parameters,
    }));
  }

  /** Declared-schema check (maxLength) so oversized args are -32602, not tool errors. */
  private maxLengthViolation(name: string, args: Record<string, unknown>): string | null {
    const def = this.listTools().find((t) => t.name === name);
    const schema = def?.inputSchema as { properties?: Record<string, { maxLength?: number }> } | undefined;
    const props = schema?.properties;
    if (!props) return null;
    for (const [key, prop] of Object.entries(props)) {
      const value = args[key];
      if (typeof value === "string" && typeof prop.maxLength === "number" && value.length > prop.maxLength) {
        return `argument "${key}" exceeds maxLength ${prop.maxLength}`;
      }
    }
    return null;
  }

  /** Build the per-call context: progress/log notifications, sampling, elicitation, stream control. */
  private toolContext(params: Record<string, unknown>, ctx: ProcessContext): ToolCallContext {
    const meta = metaOf(params);
    const caps = this.clientCapsFor(meta);
    const hooks = ctx.hooks;
    const has = (v: unknown): boolean => v !== undefined && v !== null && v !== false;

    const out: ToolCallContext = { clientCapabilities: caps };

    if (hooks) {
      out.log = (level: string, data: unknown, logger?: string): void => {
        if (!this.shouldLog(level)) return;
        hooks.send({
          jsonrpc: "2.0",
          method: "notifications/message",
          params: { level, ...(logger !== undefined ? { logger } : {}), data },
        });
      };
    }

    const progressToken = meta.progressToken;
    if (hooks && progressToken !== undefined && progressToken !== null) {
      out.progress = (progress: number, total?: number, message?: string): void => {
        hooks.send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            ...(total !== undefined ? { total } : {}),
            ...(message !== undefined ? { message } : {}),
          },
        });
      };
    }

    if (hooks && has(caps.sampling)) {
      out.sample = (req) => this.requestClient("sampling/createMessage", req as Record<string, unknown>, hooks);
    }
    if (hooks && has(caps.elicitation)) {
      out.elicit = (req) => this.requestClient("elicitation/create", req as Record<string, unknown>, hooks);
    }
    if (hooks?.closeStream) {
      const close = hooks.closeStream.bind(hooks);
      out.closeStream = (): void => close();
    }
    return out;
  }

  private clientCapsFor(meta: Record<string, unknown>): Record<string, unknown> {
    const perRequest = meta[META_CLIENT_CAPS];
    if (perRequest && typeof perRequest === "object") return perRequest as Record<string, unknown>;
    return this.clientCaps;
  }

  private shouldLog(level: string): boolean {
    const idx = (LOG_LEVELS as readonly string[]).indexOf(level);
    if (idx === -1) return true;
    return idx >= (LOG_LEVELS as readonly string[]).indexOf(this.logLevel);
  }

  private capabilities(): Record<string, unknown> {
    const caps: Record<string, unknown> = { tools: { listChanged: false }, logging: {} };
    if (this.host.listResources) {
      caps.resources = { subscribe: true, listChanged: false };
    }
    if (this.host.listPrompts) {
      caps.prompts = { listChanged: false };
    }
    if (this.host.complete) {
      caps.completions = {};
    }
    return caps;
  }

  private serverMeta(): Record<string, unknown> {
    return { [META_SERVER_INFO]: { name: this.serverName, version: this.version } };
  }
}

function metaOf(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const meta = params?._meta;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

function methodOf(msg: unknown): string | undefined {
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    const method = (msg as JsonRpcMessage).method;
    if (typeof method === "string") return method;
  }
  return undefined;
}

function idOf(msg: unknown): unknown {
  if (msg && typeof msg === "object" && !Array.isArray(msg)) {
    const id = (msg as JsonRpcMessage).id;
    if (id !== undefined) return id;
  }
  return null;
}

function errOutcome(
  id: unknown,
  code: number,
  message: string,
  data: unknown,
  httpStatus: number,
): ProcessOutcome {
  return {
    response: {
      jsonrpc: "2.0",
      id: id === undefined ? null : id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    },
    httpStatus,
  };
}

function statusFor(response: unknown): number {
  if (!response || typeof response !== "object") return 200;
  const error = (response as { error?: { code?: unknown } }).error;
  if (!error || typeof error.code !== "number") return 200;
  switch (error.code) {
    case -32601:
      return 404;
    case -32020:
    case -32022:
    case -32700:
    case -32600:
    case -32602:
      return 400;
    case -32603:
      return 500;
    default:
      return 400;
  }
}
