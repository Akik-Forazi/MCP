/**
 * xorvoidTools — the XorVoid fix-loop toolbelt.
 *
 * One call builds a Toolbox with 25 hardcoded tools covering the full
 * "grind a bug to zero" loop: read/change files, run commands, search the
 * web for the error, inspect graph context, and check git state.
 *
 *   import { xorvoidTools } from "@fraziym/mcp/xorvoid";
 *   const tools = xorvoidTools({ workspace: "/path/to/repo" });
 *   chat({ tools: tools.specs() });           // LLM function-calling
 *   await tools.call("file_read", { path });  // local execution
 *
 * Everything destructive or network-reaching is flagged by name in
 * `Toolbox.meta()` so the caller can scope per agent role.
 */

import { AxodexTools, CodeTools, FileTools, ShellTools, WebTools } from "@fraziym/axoniz/tools";

import { Toolbox } from "../core/toolbox.ts";
import { registerAxodexTools } from "../tools/axodex.ts";
import { registerCodeTools } from "../tools/code.ts";
import { registerFileTools } from "../tools/files.ts";
import { registerGitTools } from "../tools/git.ts";
import { registerShellTools } from "../tools/shell.ts";
import { registerWebTools } from "../tools/web.ts";

export interface XorvoidToolsOptions {
  /** Repository/working directory every tool is confined to. */
  workspace: string;
}

export function xorvoidTools(opts: XorvoidToolsOptions): Toolbox {
  const ws = opts.workspace;
  const tb = new Toolbox();

  registerFileTools(tb, new FileTools(ws));
  registerShellTools(tb, new ShellTools(ws));
  registerWebTools(tb, new WebTools(ws));
  registerGitTools(tb, new ShellTools(ws));
  registerCodeTools(tb, new CodeTools(ws));
  registerAxodexTools(tb, new AxodexTools(ws));

  return tb;
}
