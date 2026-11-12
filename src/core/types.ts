/**
 * Shared tool types — OpenAI/OpenRouter-compatible function schemas.
 *
 * The shape mirrors axoniz's `ToolFunctionSchema` so one toolbelt can be
 * handed to any chat-completions loop (OpenRouter, OrcaRouter, local) without
 * conversion. Handlers return plain text by default; a handler may also
 * return MCP content blocks (image/audio/embedded resource) when the result
 * is richer than text.
 */

export interface JsonSchemaProp {
  type?: string;
  description?: string;
  default?: unknown;
  maxLength?: number;
}

export interface ToolFunctionSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, JsonSchemaProp>;
      required: string[];
    };
  };
}

/** Capability flags used by routers/agents to scope tools per role. */
export interface ToolMeta {
  /** Never modifies state (published as MCP `readOnlyHint`/`destructiveHint`). */
  readOnly?: boolean;
  /** Can modify or delete state (files, processes). */
  destructive?: boolean;
  /** Reaches the network. */
  network?: boolean;
}

/** MCP tool-result content blocks. */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType?: string; text?: string; blob?: string };
    };

/**
 * Per-call context handed to tool handlers by the protocol server.
 * All fields are optional so plain `Toolbox.call(name, args)` use stays
 * unchanged outside a live session.
 */
export interface ToolCallContext {
  /**
   * Report progress for the current request (only when the client sent
   * `_meta.progressToken`). `total` is optional per spec.
   */
  progress?: (progress: number, total?: number, message?: string) => void;
  /**
   * Emit a `notifications/message` log line for the current request.
   * Levels follow RFC 5424 severity filtering against `logging/setLevel`.
   */
  log?: (level: string, data: unknown) => void;
  /**
   * Ask the client for an LLM completion (`sampling/createMessage`).
   * Rejects when the client did not declare the sampling capability.
   */
  sample?: (params: Record<string, unknown>) => Promise<unknown>;
  /**
   * Ask the client to collect user input (`elicitation/create`).
   * Rejects when the client did not declare the elicitation capability.
   */
  elicit?: (params: Record<string, unknown>) => Promise<unknown>;
  /**
   * Client capabilities captured at initialize ({} before a handshake).
   */
  clientCapabilities?: Record<string, unknown>;
  /**
   * SSE transports only: close the current POST stream mid-call so the
   * client must reconnect with `Last-Event-ID` to collect the result
   * (SEP-1699 polling). No-op on transports without a stream.
   */
  closeStream?: () => void;
  /** True when the current request rides an SSE response stream. */
  streaming?: boolean;
}

export type ToolResult = string | McpContentBlock[];

/** Flatten a tool result to text for CLIs that only print strings. */
export function renderToolResult(result: ToolResult): string {
  if (typeof result === "string") return result;
  const parts: string[] = [];
  for (const block of result) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push(`[image ${block.mimeType}]`);
    else if (block.type === "audio") parts.push(`[audio ${block.mimeType}]`);
    else parts.push(`[resource ${block.resource.uri}]`);
  }
  return parts.join("\n");
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx?: ToolCallContext,
) => ToolResult | Promise<ToolResult>;

export interface RegisteredTool {
  schema: ToolFunctionSchema;
  handler: ToolHandler;
  meta: ToolMeta;
}
