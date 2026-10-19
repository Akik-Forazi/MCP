/**
 * axonizTools — the full 72-tool axoniz surface, callable exactly like xorvoidTools.
 *
 * Composition (72):
 *   files 7 · shell 2 · web 2 · code 4 · git 10 · axodex 7 · computer 7
 *   memory 20 (plain KV + palace + knowledge graph + diary via UnifiedMemory)
 *   misc 3 (get_time, done, absolute_query)
 *   agent-runtime 10 (swarm/shadow/war-room/goals — explicit stubs until axoniz
 *   exports those subsystems standalone)
 *
 * Every handler is guarded by default (workspace jail via `guardToolbox`).
 */

import { UnifiedMemory } from "@fraziym/axoniz/memory";
import { CodeTools, ComputerTools, FileTools, ShellTools, WebTools } from "@fraziym/axoniz/tools";

import { guardToolbox, type GuardOptions } from "../core/guard.ts";
import { Toolbox } from "../core/toolbox.ts";
import { AxodexRunner, registerAxodexTools, type AxodexToolsMode } from "../tools/axodex.ts";
import { registerCodeTools } from "../tools/code.ts";
import { registerComputerTools } from "../tools/computer.ts";
import { registerFileTools } from "../tools/files.ts";
import { registerGitTools } from "../tools/git.ts";
import { registerMemoryTools } from "../tools/memory.ts";
import { registerMiscTools } from "../tools/misc.ts";
import { registerShellTools } from "../tools/shell.ts";
import { registerStubTools } from "../tools/stubs.ts";
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
  const mem = new UnifiedMemory({
    agent_name: opts.agentName ?? "fraziym-mcp",
    ...(opts.memoryPaths ?? {}),
  });

  registerFileTools(tb, new FileTools(ws), { extras: false });
  registerShellTools(tb, new ShellTools(ws));
  registerWebTools(tb, new WebTools(ws));
  registerCodeTools(tb, new CodeTools(ws));
  registerGitTools(tb, ws, "full");
  registerAxodexTools(tb, axodex, opts.axodexMode ?? "full");
  registerComputerTools(tb, new ComputerTools(ws));
  registerMemoryTools(tb, mem);
  registerMiscTools(tb, { axodex, mem });
  registerStubTools(tb);

  if (opts.guard === false) return tb;
  return guardToolbox(tb, { root: ws, ...opts.guard });
}
