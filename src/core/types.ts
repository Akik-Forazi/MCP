/**
 * Shared tool types — OpenAI/OpenRouter-compatible function schemas.
 *
 * The shape mirrors axoniz's `ToolFunctionSchema` so one toolbelt can be
 * handed to any chat-completions loop (OpenRouter, OrcaRouter, local) without
 * conversion.
 */

export interface JsonSchemaProp {
  type?: string;
  description?: string;
  default?: unknown;
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
  /** Can modify or delete state (files, processes). */
  destructive?: boolean;
  /** Reaches the network. */
  network?: boolean;
}

export type ToolHandler = (args: Record<string, unknown>) => string | Promise<string>;

export interface RegisteredTool {
  schema: ToolFunctionSchema;
  handler: ToolHandler;
  meta: ToolMeta;
}
