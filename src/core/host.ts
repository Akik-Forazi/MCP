/**
 * LazyToolHost — catalog-driven tool host for `serve`, `tools` and `call`.
 *
 * `tools/list` is answered from the static catalog (no axoniz import, no
 * memory open). The first call of a tool builds only that tool's family,
 * memoized per process. Guarding (workspace jail, arg caps, truncation,
 * optional audit) is applied per family at build time.
 */

import { loadCatalog, toolsForGroup, type CatalogTool, type ToolGroup } from "./catalog.ts";
import { buildFamily, createFamilyContext, familyKey, type FamilyContext } from "./families.ts";
import {
  ServerFeatures,
  type CompletionResult,
  type GetPromptResult,
  type PromptDef,
  type ResourceContents,
  type ResourceDef,
  type ResourceTemplateDef,
} from "./features.ts";
import { guardToolbox, type GuardOptions } from "./guard.ts";
import { mcpHome } from "./home.ts";
import type { Toolbox } from "./toolbox.ts";
import type { McpContentBlock, ToolCallContext, ToolFunctionSchema, ToolMeta } from "./types.ts";

export interface HostOptions {
  workspace?: string;
  group?: ToolGroup;
  readOnly?: boolean;
  noNetwork?: boolean;
  /** Guard tuning. Default: on with audit off; pass `false` to disable. */
  guard?: Partial<GuardOptions> | false;
  agentName?: string;
  memoryPaths?: { palace_path?: string; kg_path?: string };
}

export class LazyToolHost {
  readonly group: ToolGroup;
  readonly workspace: string;
  private readonly tools: CatalogTool[];
  private readonly byName = new Map<string, CatalogTool>();
  private readonly families = new Map<string, Promise<Toolbox>>();
  private readonly ctx: FamilyContext;
  private readonly guard: Partial<GuardOptions> | false;
  private readonly features: ServerFeatures;

  constructor(opts: HostOptions = {}) {
    const catalog = loadCatalog();
    if (!catalog) {
      throw new Error("catalog.json not found — run `npm run catalog` (or `npm run build`) first");
    }
    this.workspace = opts.workspace ?? process.cwd();
    this.group = opts.group ?? "all";
    this.guard = opts.guard ?? {};
    this.features = new ServerFeatures({ workspace: this.workspace, home: mcpHome() });

    let list = toolsForGroup(catalog, this.group);
    if (opts.readOnly) list = list.filter((t) => t.meta.destructive !== true);
    if (opts.noNetwork) list = list.filter((t) => t.meta.network !== true);
    this.tools = list;
    for (const t of list) this.byName.set(t.name, t);

    this.ctx = createFamilyContext(this.workspace, {
      ...(opts.agentName ? { agentName: opts.agentName } : {}),
      ...(opts.memoryPaths ? { memoryPaths: opts.memoryPaths } : {}),
    });
  }

  names(): string[] {
    return this.tools.map((t) => t.name);
  }

  catalogTools(): CatalogTool[] {
    return this.tools;
  }

  specs(): ToolFunctionSchema[] {
    return this.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  /** MCP tool definitions with annotations derived from catalog meta. */
  definitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, boolean>;
  }> {
    return this.tools.map((t) => {
      const annotations: Record<string, boolean> = {};
      if (t.meta.readOnly === true) {
        annotations.readOnlyHint = true;
        annotations.destructiveHint = false;
      }
      if (t.meta.destructive === true) annotations.destructiveHint = true;
      if (t.meta.network === true) annotations.openWorldHint = true;
      return {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      };
    });
  }

  meta(name: string): ToolMeta | undefined {
    return this.byName.get(name)?.meta;
  }

  /** Build (once) the family toolbox for `key`, guarded per host options. */
  family(key: string): Promise<Toolbox> {
    let fam = this.families.get(key);
    if (!fam) {
      fam = buildFamily(key, this.ctx).then((tb) => {
        if (this.guard === false) return tb;
        return guardToolbox(tb, { root: this.workspace, ...this.guard });
      });
      this.families.set(key, fam);
    }
    return fam;
  }

  async call(name: string, args: Record<string, unknown> = {}, ctx?: ToolCallContext): Promise<string | McpContentBlock[]> {
    const entry = this.byName.get(name);
    if (!entry) return `[ERROR] Unknown tool: ${name}`;
    const key = familyKey(this.group, name);
    if (!key) return `[ERROR] Unknown tool: ${name}`;
    const tb = await this.family(key);
    return tb.call(name, args, ctx);
  }

  listResources(): ResourceDef[] {
    return this.features.listResources();
  }

  listResourceTemplates(): ResourceTemplateDef[] {
    return this.features.listResourceTemplates();
  }

  readResource(uri: string): ResourceContents {
    const allowOutside = this.guard !== false && this.guard.allowOutside === true;
    return this.features.readResource(uri, { allowOutside });
  }

  listPrompts(): PromptDef[] {
    return this.features.listPrompts();
  }

  getPrompt(name: string, args: Record<string, string>): GetPromptResult {
    return this.features.getPrompt(name, args);
  }

  complete(
    ref: { type?: unknown; name?: unknown; uri?: unknown },
    argument: { name?: unknown; value?: unknown },
  ): CompletionResult {
    return this.features.complete(ref, argument);
  }
}
