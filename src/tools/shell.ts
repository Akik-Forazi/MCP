/**
 * Shell tool wrappers — binds axoniz `ShellTools` (Windows-aware) to
 * shell_run / shell_python tools.
 */

import type { ShellTools } from "@fraziym/axoniz/tools";

import { argInt, argStr } from "../core/args.ts";
import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

export function registerShellTools(tb: Toolbox, st: ShellTools): void {
  tb.register(
    "shell_run",
    "Run a shell/CMD command in the workspace. Returns exit code, stdout, stderr.",
    { command: S("Command line to run"), timeout: I("Timeout in seconds (default 60)") },
    ["command"],
    (args) => st.run(argStr(args, "command"), argInt(args, "timeout", 60)),
    { destructive: true },
  );

  tb.register(
    "shell_python",
    "Execute Python code and capture output (requires a python interpreter).",
    { code: S("Python source to execute") },
    ["code"],
    (args) => st.runPython(argStr(args, "code")),
    { destructive: true },
  );
}
