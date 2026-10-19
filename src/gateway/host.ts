/**
 * GatewayHost — ToolHostLike wrapper that appends the gateway endpoints
 * (router_*, fix_*, brain_*, tools_discover, audit_tail) to a LazyToolHost.
 *
 * Only used when `serve --router-tools` is set: tools/list then advertises
 * 74 + 13 = 87 tools, and calls to gateway names are handled here; every
 * other name goes straight to the lazy catalog host.
 */

import { guardToolbox, type GuardOptions } from "../core/guard.ts";
import type { LazyToolHost } from "../core/host.ts";
import type { Toolbox } from "../core/toolbox.ts";
import type { ToolFunctionSchema, ToolMeta } from "../core/types.ts";
import type { ToolHostLike } from "../protocol/server.ts";
import { createFamilyContext } from "../core/families.ts";
import { buildGatewayToolbox, isGatewayTool, type GatewayDeps } from "./registry.ts";

export interface GatewayHostOptions {
  home: string;
  /** Shared Fraziym config dir; defaults to ~/.fraziym ($FRAZIYM_HOME). */
  configHome?: string;
  guard?: Partial<GuardOptions> | false;
}

export class GatewayHost implements ToolHostLike {
  private readonly base: LazyToolHost;
  private readonly gateway: Toolbox;

  constructor(base: LazyToolHost, opts: GatewayHostOptions) {
    this.base = base;
    const deps: GatewayDeps = {
      workspace: base.workspace,
      home: opts.home,
      ...(opts.configHome ? { configHome: opts.configHome } : {}),
      ctx: createFamilyContext(base.workspace, { agentName: "fraziym-mcp-gateway" }),
    };
    const built = buildGatewayToolbox(deps);
    this.gateway = opts.guard === false ? built : guardToolbox(built, { root: base.workspace, ...opts.guard });
  }

  names(): string[] {
    return [...this.base.names(), ...this.gateway.names()];
  }

  specs(): ToolFunctionSchema[] {
    return [...this.base.specs(), ...this.gateway.specs()];
  }

  definitions(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, boolean>;
  }> {
    const gatewayDefs = this.gateway.specs().map((schema) => {
      const meta = this.gateway.meta(schema.function.name) ?? {};
      const annotations: Record<string, boolean> = {};
      if (meta.readOnly === true) {
        annotations.readOnlyHint = true;
        annotations.destructiveHint = false;
      }
      if (meta.destructive === true) annotations.destructiveHint = true;
      if (meta.network === true) annotations.openWorldHint = true;
      return {
        name: schema.function.name,
        description: schema.function.description,
        inputSchema: schema.function.parameters as unknown as Record<string, unknown>,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      };
    });
    return [...this.base.definitions(), ...gatewayDefs];
  }

  meta(name: string): ToolMeta | undefined {
    return this.gateway.has(name) ? this.gateway.meta(name) : this.base.meta(name);
  }

  call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (isGatewayTool(name)) return this.gateway.call(name, args);
    return this.base.call(name, args);
  }
}
