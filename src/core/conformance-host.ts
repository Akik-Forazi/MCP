/**
 * ConformanceHost — layers the official-suite fixtures (src/tools/conformance.ts)
 * on top of any real host (LazyToolHost or GatewayHost).
 *
 * Enabled only by `serve --conformance`. Fixture tools are appended to
 * tools/list, fixture resources/prompts to the feature lists, and fixture
 * names (`test_*`, `test://…`) are routed to the fixtures; everything else
 * falls through to the real product surface. The catalog tool count is
 * untouched.
 */

import { ConformanceFixtures } from "../tools/conformance.ts";
import type { ToolCallContext, ToolFunctionSchema, ToolMeta, ToolResult } from "./types.ts";
import type { ToolHostLike } from "../protocol/server.ts";
import type {
  CompletionResult,
  GetPromptResult,
  PromptDef,
  ResourceContents,
  ResourceDef,
  ResourceTemplateDef,
} from "./features.ts";

type BaseHost = ToolHostLike & { meta?: (name: string) => ToolMeta | undefined };

function annotationsFor(meta: ToolMeta): Record<string, boolean> {
  const annotations: Record<string, boolean> = {};
  if (meta.readOnly === true) {
    annotations.readOnlyHint = true;
    annotations.destructiveHint = false;
  }
  if (meta.destructive === true) annotations.destructiveHint = true;
  if (meta.network === true) annotations.openWorldHint = true;
  return annotations;
}

export class ConformanceHost implements ToolHostLike {
  private readonly base: BaseHost;
  private readonly fixtures = new ConformanceFixtures();

  constructor(base: BaseHost) {
    this.base = base;
  }

  names(): string[] {
    return [...this.base.names(), ...this.fixtures.toolbox.names()];
  }

  specs(): ToolFunctionSchema[] {
    return [...this.base.specs(), ...this.fixtures.toolbox.specs()];
  }

  definitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, boolean>;
  }> {
    const fixtureDefs = this.fixtures.toolbox.specs().map((schema) => {
      const meta = this.fixtures.toolbox.meta(schema.function.name) ?? {};
      const annotations = annotationsFor(meta);
      return {
        name: schema.function.name,
        description: schema.function.description,
        inputSchema: schema.function.parameters as unknown as Record<string, unknown>,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      };
    });
    return [...(this.base.definitions?.() ?? []), ...fixtureDefs];
  }

  meta(name: string): ToolMeta | undefined {
    return this.fixtures.toolbox.has(name) ? this.fixtures.toolbox.meta(name) : this.base.meta?.(name);
  }

  call(name: string, args: Record<string, unknown> = {}, ctx?: ToolCallContext): Promise<ToolResult> {
    if (this.fixtures.toolbox.has(name)) return this.fixtures.toolbox.call(name, args, ctx);
    return this.base.call(name, args, ctx);
  }

  listResources(): ResourceDef[] {
    return [...this.fixtures.listResources(), ...(this.base.listResources?.() ?? [])];
  }

  listResourceTemplates(): ResourceTemplateDef[] {
    return [...this.fixtures.listResourceTemplates(), ...(this.base.listResourceTemplates?.() ?? [])];
  }

  readResource(uri: string): ResourceContents {
    if (uri.startsWith("test://")) return this.fixtures.readResource(uri);
    if (!this.base.readResource) throw new Error(`no resource host for ${uri}`);
    return this.base.readResource(uri);
  }

  listPrompts(): PromptDef[] {
    return [...this.fixtures.listPrompts(), ...(this.base.listPrompts?.() ?? [])];
  }

  getPrompt(name: string, args: Record<string, string>): GetPromptResult {
    if (name.startsWith("test_")) return this.fixtures.getPrompt(name, args);
    if (!this.base.getPrompt) throw new Error(`no prompt host for ${name}`);
    return this.base.getPrompt(name, args);
  }

  complete(
    ref: { type?: unknown; name?: unknown; uri?: unknown },
    argument: { name?: unknown; value?: unknown },
  ): CompletionResult {
    const uri = typeof ref.uri === "string" ? ref.uri : "";
    const name = typeof ref.name === "string" ? ref.name : "";
    if (uri.startsWith("test://") || name.startsWith("test_")) {
      return this.fixtures.complete(ref, argument);
    }
    return this.base.complete?.(ref, argument) ?? { values: [] };
  }
}
