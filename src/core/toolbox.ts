/**
 * Toolbox — a named collection of hardcoded tools.
 *
 * `specs()` feeds the LLM (function-calling API), `call()` executes locally.
 * Handlers always resolve to a string; thrown errors become `[ERROR] ...`
 * result strings so an agent loop can never crash on a tool failure.
 */

import type {
  JsonSchemaProp,
  RegisteredTool,
  ToolFunctionSchema,
  ToolHandler,
  ToolMeta,
} from "./types.ts";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class Toolbox {
  private readonly tools = new Map<string, RegisteredTool>();

  register(
    name: string,
    description: string,
    properties: Record<string, JsonSchemaProp>,
    required: string[],
    handler: ToolHandler,
    meta: ToolMeta = {},
  ): this {
    this.tools.set(name, {
      schema: {
        type: "function",
        function: {
          name,
          description,
          parameters: { type: "object", properties, required },
        },
      },
      handler,
      meta,
    });
    return this;
  }

  /** Register with a pre-built OpenAI function schema (used verbatim). */
  registerSpec(schema: ToolFunctionSchema, handler: ToolHandler, meta: ToolMeta = {}): this {
    this.tools.set(schema.function.name, { schema, handler, meta });
    return this;
  }

  /** New Toolbox with the matching tools only (same handlers/meta). */
  subset(pred: (schema: ToolFunctionSchema, meta: ToolMeta) => boolean): Toolbox {
    const out = new Toolbox();
    for (const t of this.tools.values()) {
      if (pred(t.schema, t.meta)) out.registerSpec(t.schema, t.handler, t.meta);
    }
    return out;
  }

  /** New Toolbox = this + the tools of `other` that are not already present. */
  merge(other: Toolbox): Toolbox {
    const out = this.subset(() => true);
    for (const t of other.tools.values()) {
      if (!out.tools.has(t.schema.function.name)) out.registerSpec(t.schema, t.handler, t.meta);
    }
    return out;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  specs(): ToolFunctionSchema[] {
    return [...this.tools.values()].map((t) => t.schema);
  }

  meta(name: string): ToolMeta | undefined {
    return this.tools.get(name)?.meta;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `[ERROR] Unknown tool: ${name}`;
    try {
      return await tool.handler(args);
    } catch (e) {
      return `[ERROR] ${name}: ${errText(e)}`;
    }
  }
}
