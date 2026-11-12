/**
 * Git tools — argv-exact git via `execFile`, scoped to the workspace.
 *
 * Nothing here goes through a shell: commands are built as real argument
 * arrays, so commit messages, paths and ref names can never break out
 * (CVE-2025-68144-style argument injection is structurally impossible).
 * Free-form names (branches, remotes) are additionally validated and may
 * not start with "-".
 *
 * mode "core": read-only trio (git_status, git_diff, git_log) — xorvoidTools default.
 * mode "full": the complete axoniz 10-tool git surface
 *              (+ add/commit/branch/checkout/push/pull/stash).
 */

import { argInt, argStr } from "../core/args.ts";
import { execCapture } from "../core/exec.ts";
import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

export type GitToolsMode = "core" | "full";

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
};

/** Conservative ref/remote-name validation: no leading dash, no shell-ish metacharacters. */
function refName(value: string, what: string): string {
  const v = value.trim();
  if (!v) throw new Error(`${what} must not be empty`);
  if (v.length > 255) throw new Error(`${what} is too long`);
  if (v.startsWith("-")) throw new Error(`${what} must not start with "-"`);
  if (!/^[A-Za-z0-9._/-]+$/.test(v)) throw new Error(`${what} contains unsupported characters`);
  if (v.includes("..") || v.endsWith("/") || v.endsWith(".") || v.endsWith(".lock")) {
    throw new Error(`${what} is not a valid git name`);
  }
  return v;
}

async function runGit(workspace: string, argv: string[]): Promise<string> {
  const res = await execCapture("git", argv, { cwd: workspace, env: GIT_ENV, timeoutMs: 120_000 });
  if (res.spawnError === "ENOENT") return "[ERROR] git not found on PATH";
  if (res.timedOut) return "[ERROR] git timed out after 120s";
  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout).trim() || `exit code ${res.code}`;
    return `[ERROR] git ${argv[0] ?? ""}: ${msg}`;
  }
  return res.stdout.trim() || res.stderr.trim() || "(no output)";
}

export function registerGitTools(tb: Toolbox, workspace: string, mode: GitToolsMode = "core"): void {
  tb.register(
    "git_status",
    "Show git working-tree status (short + branch).",
    {},
    [],
    () => runGit(workspace, ["status", "--short", "--branch"]),
    { readOnly: true },
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
      const argv = ["diff"];
      if (args.staged === true || args.staged === "true") argv.push("--staged");
      const p = argStr(args, "path");
      if (p) argv.push("--", p);
      return runGit(workspace, argv);
    },
    { readOnly: true },
  );

  tb.register(
    "git_log",
    "Recent commit history (one line per commit).",
    { count: I("Number of commits (default 10)") },
    [],
    (args) => {
      const n = Math.min(Math.max(argInt(args, "count", 10), 1), 1000);
      return runGit(workspace, ["log", "--oneline", "-n", String(n)]);
    },
    { readOnly: true },
  );

  if (mode !== "full") return;

  tb.register(
    "git_add",
    "Stage files for commit.",
    { path: S('Path to stage (default ".")') },
    [],
    (args) => runGit(workspace, ["add", "--", argStr(args, "path", ".")]),
  );

  tb.register(
    "git_commit",
    "Create a git commit.",
    { message: S("Commit message") },
    ["message"],
    (args) => runGit(workspace, ["commit", "-m", argStr(args, "message")]),
    { destructive: true },
  );

  tb.register("git_branch", "List git branches.", {}, [], () => runGit(workspace, ["branch", "--list"]), {
    readOnly: true,
  });

  tb.register(
    "git_checkout",
    "Switch/create branch.",
    { branch: S("Branch name"), create: { type: "boolean", description: "Create the branch (-b)" } },
    ["branch"],
    (args) => {
      const branch = refName(argStr(args, "branch"), "branch");
      const argv = ["checkout"];
      if (args.create === true || args.create === "true") argv.push("-b");
      argv.push(branch);
      return runGit(workspace, argv);
    },
    { destructive: true },
  );

  tb.register(
    "git_push",
    "Push to remote.",
    { remote: S("Remote (default: current)"), branch: S("Branch (default: current)") },
    [],
    (args) => {
      const argv = ["push"];
      const r = argStr(args, "remote").trim();
      const b = argStr(args, "branch").trim();
      if (r) argv.push(refName(r, "remote"));
      if (b) argv.push(refName(b, "branch"));
      return runGit(workspace, argv);
    },
    { destructive: true, network: true },
  );

  tb.register("git_pull", "Pull from remote.", {}, [], () => runGit(workspace, ["pull"]), {
    destructive: true,
    network: true,
  });

  tb.register("git_stash", "Stash uncommitted changes.", {}, [], () => runGit(workspace, ["stash"]), {
    destructive: true,
  });
}
