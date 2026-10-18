/**
 * Git tool wrappers — shell-backed read-only git visibility (status/diff/log)
 * on top of axoniz `ShellTools`, scoped to the workspace.
 */

import type { ShellTools } from "@fraziym/axoniz/tools";

import { argInt, argStr } from "../core/args.ts";
import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

export function registerGitTools(tb: Toolbox, st: ShellTools): void {
  tb.register(
    "git_status",
    "Show git working-tree status (short + branch).",
    {},
    [],
    () => st.run("git status --short --branch"),
  );

  tb.register(
    "git_diff",
    "Show unstaged or staged changes.",
    {
      staged: { type: "boolean", description: "Show staged (--staged) diff instead" },
      path: S("Limit the diff to this path"),
    },
    [],
    (args) => {
      let cmd = "git diff";
      if (args.staged === true || args.staged === "true") cmd += " --staged";
      const p = argStr(args, "path");
      if (p) cmd += ` -- "${p}"`;
      return st.run(cmd);
    },
  );

  tb.register(
    "git_log",
    "Recent commit history (one line per commit).",
    { count: I("Number of commits (default 10)") },
    [],
    (args) => st.run(`git log --oneline -n ${argInt(args, "count", 10)}`),
  );
}
