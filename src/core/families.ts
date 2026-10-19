/**
 * Families — lazily-built Toolboxes, one per tool family.
 *
 * The catalog answers `tools/list` without loading anything; the first tool
 * call from a family triggers its `await import()` and construction. So a
 * server that only ever gets e.g. `file_read` never pays for UnifiedMemory,
 * ComputerTools, or the axodex resolver.
 */

import type { UnifiedMemory } from "@fraziym/axoniz/memory";

import type { ToolGroup } from "./catalog.ts";
import { Toolbox } from "./toolbox.ts";
import { AxodexRunner, registerAxodexTools, type AxodexToolsMode } from "../tools/axodex.ts";
import { registerCodeTools } from "../tools/code.ts";
import { registerComputerTools } from "../tools/computer.ts";
import { registerFileTools } from "../tools/files.ts";
import { registerGitTools, type GitToolsMode } from "../tools/git.ts";
import { registerMemoryTools } from "../tools/memory.ts";
import { registerMiscTools, registerProtocolTools } from "../tools/misc.ts";
import { registerShellTools } from "../tools/shell.ts";
import { registerStubTools, STUB_TOOL_NAMES } from "../tools/stubs.ts";
import { registerWebTools } from "../tools/web.ts";

export interface FamilyContext {
  workspace: string;
  agentName: string;
  memoryPaths?: { palace_path?: string; kg_path?: string };
  /** Shared AxodexRunner (lightweight; resolves the CLI lazily on call). */
  axodex(): AxodexRunner;
  /** Shared UnifiedMemory (heavy: opens sqlite-style stores on first use). */
  memory(): Promise<UnifiedMemory>;
}

export function createFamilyContext(
  workspace: string,
  opts: { agentName?: string; memoryPaths?: { palace_path?: string; kg_path?: string } } = {},
): FamilyContext {
  let axodex: AxodexRunner | undefined;
  let memPromise: Promise<UnifiedMemory> | undefined;
  const ctx: FamilyContext = {
    workspace,
    agentName: opts.agentName ?? "fraziym-mcp",
    ...(opts.memoryPaths ? { memoryPaths: opts.memoryPaths } : {}),
    axodex() {
      axodex ??= new AxodexRunner(workspace);
      return axodex;
    },
    async memory() {
      if (!memPromise) {
        memPromise = import("@fraziym/axoniz/memory").then(({ UnifiedMemory: UM }) => {
          return new UM({
            agent_name: ctx.agentName,
            ...(ctx.memoryPaths ?? {}),
          });
        });
      }
      return memPromise;
    },
  };
  return ctx;
}

type Builder = (ctx: FamilyContext) => Promise<Toolbox>;

const builders: Record<string, Builder> = {
  files_axoniz: async (ctx) => {
    const { FileTools } = await import("@fraziym/axoniz/tools");
    const tb = new Toolbox();
    registerFileTools(tb, new FileTools(ctx.workspace), { extras: false });
    return tb;
  },

  files_full: async (ctx) => {
    const { FileTools } = await import("@fraziym/axoniz/tools");
    const tb = new Toolbox();
    registerFileTools(tb, new FileTools(ctx.workspace));
    return tb;
  },

  shell: async (ctx) => {
    const { ShellTools } = await import("@fraziym/axoniz/tools");
    const tb = new Toolbox();
    registerShellTools(tb, new ShellTools(ctx.workspace));
    return tb;
  },

  web: async (ctx) => {
    const { WebTools } = await import("@fraziym/axoniz/tools");
    const tb = new Toolbox();
    registerWebTools(tb, new WebTools(ctx.workspace));
    return tb;
  },

  code: async (ctx) => {
    const { CodeTools } = await import("@fraziym/axoniz/tools");
    const tb = new Toolbox();
    registerCodeTools(tb, new CodeTools(ctx.workspace));
    return tb;
  },

  git_core: (ctx) => {
    const tb = new Toolbox();
    registerGitTools(tb, ctx.workspace, "core");
    return Promise.resolve(tb);
  },

  git_full: (ctx) => {
    const tb = new Toolbox();
    registerGitTools(tb, ctx.workspace, "full");
    return Promise.resolve(tb);
  },

  axodex_core: (ctx) => {
    const tb = new Toolbox();
    registerAxodexTools(tb, ctx.axodex(), "core");
    return Promise.resolve(tb);
  },

  axodex_full: (ctx) => {
    const tb = new Toolbox();
    registerAxodexTools(tb, ctx.axodex(), "full");
    return Promise.resolve(tb);
  },

  computer: async (ctx) => {
    const { ComputerTools } = await import("@fraziym/axoniz/tools");
    const tb = new Toolbox();
    registerComputerTools(tb, new ComputerTools(ctx.workspace));
    return tb;
  },

  memory: async (ctx) => {
    const tb = new Toolbox();
    registerMemoryTools(tb, await ctx.memory());
    return tb;
  },

  protocol: () => {
    const tb = new Toolbox();
    registerProtocolTools(tb);
    return Promise.resolve(tb);
  },

  misc: async (ctx) => {
    const tb = new Toolbox();
    registerMiscTools(tb, { axodex: ctx.axodex(), mem: await ctx.memory() });
    return tb;
  },

  stubs: () => {
    const tb = new Toolbox();
    registerStubTools(tb);
    return Promise.resolve(tb);
  },
};

const STUBS = new Set<string>(STUB_TOOL_NAMES);

/** Map a tool name to the family that owns it, for the requested group. */
export function familyKey(group: ToolGroup, name: string): string | null {
  if (name.startsWith("file_")) return group === "axoniz" ? "files_axoniz" : "files_full";
  if (name.startsWith("shell_")) return "shell";
  if (name.startsWith("web_")) return "web";
  if (name.startsWith("code_")) return "code";
  if (name.startsWith("git_")) return group === "xorvoid" ? "git_core" : "git_full";
  if (name.startsWith("axodex_")) return group === "xorvoid" ? "axodex_core" : "axodex_full";
  if (
    name.startsWith("memory_") ||
    name.startsWith("palace_") ||
    name.startsWith("kg_") ||
    name.startsWith("diary_")
  ) {
    return "memory";
  }
  if (name.startsWith("mouse_") || name.startsWith("key_") || name.startsWith("screen_")) {
    return "computer";
  }
  if (name === "get_time" || name === "done") return "protocol";
  if (name === "absolute_query") return "misc";
  if (STUBS.has(name)) return "stubs";
  return null;
}

export function buildFamily(key: string, ctx: FamilyContext): Promise<Toolbox> {
  const builder = builders[key];
  if (!builder) throw new Error(`unknown tool family: ${key}`);
  return builder(ctx);
}
