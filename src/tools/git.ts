/**
 * Git tools — shell-backed git, scoped to the workspace.
 *
 * mode "core": read-only trio (git_status, git_diff, git_log) — xorvoidTools default.
 * mode "full": the complete axoniz 10-tool git surface
 *              (+ add/commit/branch/checkout/push/pull/stash).
 */

import type { ShellTools } from "@fraziym/axoniz/tools";

import { argInt, argStr } from "../core/args.ts";
import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

export type GitToolsMode = "core" | "full";

function q(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

export function registerGitTools(tb: Toolbox, st: ShellTools, mode: GitToolsMode = "core"): void {
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
      if (p) cmd += ` -- ${q(p)}`;
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

  if (mode !== "full") return;

  tb.register(
    "git_add",
    "Stage files for commit.",
    { path: S('Path to stage (default ".")') },
    [],
    (args) => st.run(`git add -- ${q(argStr(args, "path", "."))}`),
  );

  tb.register(
    "git_commit",
    "Create a git commit.",
    { message: S("Commit message") },
    ["message"],
    (args) => st.run(`git commit -m ${q(argStr(args, "message"))}`),
    { destructive: true },
  );

  tb.register("git_branch", "List git branches.", {}, [], () => st.run("git branch --list"));

  tb.register(
    "git_checkout",
    "Switch/create branch.",
    { branch: S("Branch name"), create: { type: "boolean", description: "Create the branch (-b)" } },
    ["branch"],
    (args) =>
      st.run(
        `git checkout ${args.create === true || args.create === "true" ? "-b " : ""}${q(argStr(args, "branch"))}`,
      ),
    { destructive: true },
  );

  tb.register(
    "git_push",
    "Push to remote.",
    { remote: S("Remote (default: current)"), branch: S("Branch (default: current)") },
    [],
    (args) => {
      const r = argStr(args, "remote");
      const b = argStr(args, "branch");
      return st.run(`git push${r ? ` ${q(r)}` : ""}${b ? ` ${q(b)}` : ""}`);
    },
    { destructive: true, network: true },
  );

  tb.register("git_pull", "Pull from remote.", {}, [], () => st.run("git pull"), {
    destructive: true,
    network: true,
  });

  tb.register("git_stash", "Stash uncommitted changes.", {}, [], () => st.run("git stash"), {
    destructive: true,
  });
}
