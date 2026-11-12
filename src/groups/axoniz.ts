/**
 * axonizTools — the full 72-tool axoniz surface, callable exactly like xorvoidTools.
 *
 * Composition (72):
 *   files 7 · shell 2 · web 2 · code 4 · git 10 · axodex 7 · computer 7
 *   memory 20 (plain KV + palace + knowledge graph + diary via UnifiedMemory)
 *   misc 3 (get_time, done, absolute_query)
 *   agent-runtime 3 (swarm/shadow/war-room — explicit stubs until axoniz
 *   exposes the live agent instance; goal_* are bound to GoalService in
 *   tools/goals.ts)
 *   exports those subsystems standalone)
 *
 * Every handler is guarded by default (workspace jail via `guardToolbox`).
 */

import { createRequire } from "node:module";

import { CodeTools, ComputerTools, FileTools, ShellTools, WebTools } from "../impl/index.ts";

import { guardToolbox, type GuardOptions } from "../core/guard.ts";
import { Toolbox } from "../core/toolbox.ts";
import type { MemoryApi } from "../impl/types/memory.ts";
import { AxodexRunner, registerAxodexTools, type AxodexToolsMode } from "../tools/axodex.ts";
import { registerCodeTools } from "../tools/code.ts";
import { registerComputerTools } from "../tools/computer.ts";
import { registerFileTools } from "../tools/files.ts";
import { registerGitTools } from "../tools/git.ts";
import { registerMemoryTools } from "../tools/memory.ts";
import { registerMiscTools } from "../tools/misc.ts";
import { registerShellTools } from "../tools/shell.ts";
import { registerAgentRuntimeTools } from "../tools/agentRuntime.ts";
import { registerGoalTools } from "../tools/goals.ts";
import { registerWebTools } from "../tools/web.ts";

export interface AxonizToolsOptions {
  /** Workspace root all file/shell/git/axodex/computer tools are scoped to. */
  workspace: string;
  /** Override palace/kg storage paths (defaults to axoniz's own home paths). */
  memoryPaths?: { palace_path?: string; kg_path?: string };
  /** Agent name recorded by UnifiedMemory (default "fraziym-mcp"). */
  agentName?: string;
  /** Guard tuning (root defaults to the workspace). `false` disables the guard layer. */
  guard?: Partial<GuardOptions> | false;
  /** Register axodex tools in core (5) or full (7) mode. Default "full". */
  axodexMode?: AxodexToolsMode;
}

export function axonizTools(opts: AxonizToolsOptions): Toolbox {
  const ws = opts.workspace;
  const tb = new Toolbox();
  const axodex = new AxodexRunner(ws);
  // Memory is optional: mcp must work without @fraziym/axoniz installed.
  // The memory_* tools are only registered when a real backend is present.
  const mem = makeLazyMemory(opts.agentName ?? "fraziym-mcp", opts.memoryPaths);

  registerFileTools(tb, new FileTools(ws), { extras: false });
  registerShellTools(tb, new ShellTools(ws));
  registerWebTools(tb, new WebTools(ws));
  registerCodeTools(tb, new CodeTools(ws));
  registerGitTools(tb, ws, "full");
  registerAxodexTools(tb, axodex, opts.axodexMode ?? "full");
  registerComputerTools(tb, new ComputerTools(ws));
  registerMemoryTools(tb, mem);
  registerMiscTools(tb, { axodex, mem });
  registerAgentRuntimeTools(tb, { workspace: ws });
  registerGoalTools(tb);

  if (opts.guard === false) return tb;
  return guardToolbox(tb, { root: ws, ...opts.guard });
}

/**
 * Load axoniz's UnifiedMemory if the optional peer is installed.
 * Returns a structural MemoryApi so mcp never hard-depends on axoniz.
 */
function makeLazyMemory(
  agentName: string,
  memoryPaths?: Record<string, unknown>,
): MemoryApi {
  let real: MemoryApi | null = null;
  let failed = false;
  const ensure = (): MemoryApi => {
    if (real) return real;
    if (failed) throw new Error("memory backend unavailable (optional @fraziym/axoniz)");
    try {
      // ESM has no in-scope `require`; createRequire resolves the optional
      // peer from the importing module's own location.
      const req = createRequire(import.meta.url) as (m: string) => Record<string, unknown>;
      const mod = req("@fraziym/axoniz/memory");
      const UM = mod.UnifiedMemory as new (o: Record<string, unknown>) => MemoryApi;
      real = new UM({ agent_name: agentName, ...(memoryPaths ?? {}) });
      return real;
    } catch {
      failed = true;
      throw new Error(
        "memory tools require @fraziym/axoniz (optional peer). " +
          "Install it to enable memory_recall / memory_remember / memory_forget.",
      );
    }
  };
  return {
    // Never throw during registration: a server without axoniz must still
    // start and serve its file/shell/git tools. Memory tools simply absent.
    as_tool_map: () => {
      try {
        return ensure().as_tool_map();
      } catch {
        return {};
      }
    },
    as_tool_schemas: () => {
      try {
        return ensure().as_tool_schemas();
      } catch {
        return [];
      }
    },
  } as MemoryApi;
}
