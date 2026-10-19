/**
 * Guard + exec security tests — the adversarial pack.
 *
 * Every rejection inside the WorkspaceJail family mirrors a known CVE class
 * (53109 symlink escape, 53110 naive prefix check). The git tests prove the
 * execFile-based runner is argument-injection proof (CVE-2025-68144 class).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { redactPreview } from "../src/core/audit.ts";
import { isWindows, parseCmdShim } from "../src/core/exec.ts";
import {
  guardToolbox,
  resolveWithin,
  truncateOutput,
  validateToolArgs,
  WorkspaceViolationError,
} from "../src/core/guard.ts";
import { Toolbox } from "../src/core/toolbox.ts";
import { registerGitTools } from "../src/tools/git.ts";

let ws = "";
let outside = "";
let root = "";

function git(cwd: string, argv: string[]): string {
  return execFileSync("git", argv, { cwd, encoding: "utf8" });
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-guard-"));
  ws = path.join(root, "workspace");
  outside = path.join(root, "outside");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(ws, "hello.txt"), "hello");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
});

after(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* junctions can linger on Windows */
  }
});

/* ── WorkspaceJail ─────────────────────────────────────────────────────── */

test("resolveWithin accepts paths that stay inside the workspace", () => {
  const base = fs.realpathSync.native(ws);
  assert.equal(resolveWithin(ws, "."), base);
  assert.equal(resolveWithin(ws, "a/../hello.txt"), path.join(base, "hello.txt"));
  assert.equal(resolveWithin(ws, "new/dir/file.txt"), path.join(base, "new", "dir", "file.txt"));
  assert.equal(resolveWithin(ws, path.join(ws, "hello.txt")), path.join(base, "hello.txt"));
});

test("validateToolArgs caps filesystem-path argument length", () => {
  const spec = {
    type: "function" as const,
    function: {
      name: "file_read",
      description: "",
      parameters: {
        type: "object" as const,
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  };
  assert.throws(
    () => validateToolArgs("file_read", spec, { path: "a".repeat(5000) }, { root: ws }),
    /path arguments are capped/,
  );
  const ok = validateToolArgs("file_read", spec, { path: "hello.txt" }, { root: ws });
  assert.equal(ok.path, path.join(fs.realpathSync.native(ws), "hello.txt"));
});

test("resolveWithin rejects the CVE-2025-53110 traversal pack", () => {
  const attacks = [
    "../secret.txt",
    "..\\secret.txt",
    "a/../../secret.txt",
    "a/..\\..\\secret.txt",
    path.join(outside, "secret.txt"),
    `${ws}-evil/x`,
    "....//....//secret.txt",
  ];
  for (const attack of attacks) {
    assert.throws(
      () => resolveWithin(ws, attack),
      (e: unknown) => e instanceof WorkspaceViolationError && /escapes workspace/.test(String(e)),
      `attack slipped through: ${attack}`,
    );
  }
});

test("resolveWithin rejects windows device paths", { skip: !isWindows }, () => {
  const attacks = [
    "\\\\?\\C:\\Windows\\win.ini",
    "\\\\.\\C:\\Windows\\win.ini",
    "NUL",
    "con.txt",
    "evil.txt.",
    "evil.txt ",
    "\\\\server\\share\\x",
  ];
  for (const attack of attacks) {
    assert.throws(
      () => resolveWithin(ws, attack),
      (e: unknown) => e instanceof WorkspaceViolationError,
      `attack slipped through: ${attack}`,
    );
  }
});

test("resolveWithin rejects symlink/junction escapes (CVE-2025-53109)", (t) => {
  const link = path.join(ws, "link");
  try {
    fs.symlinkSync(outside, link, isWindows ? "junction" : "dir");
  } catch {
    t.skip("cannot create symlinks in this environment");
    return;
  }
  assert.throws(
    () => resolveWithin(ws, "link/secret.txt"),
    (e: unknown) => e instanceof WorkspaceViolationError,
    "symlinked escape slipped through",
  );
});

test("allowOutside opts out of containment but keeps device checks", { skip: !isWindows }, () => {
  const resolved = resolveWithin(ws, path.join(outside, "secret.txt"), true);
  assert.ok(resolved.toLowerCase().includes("outside"));
  assert.throws(() => resolveWithin(ws, "NUL", true), WorkspaceViolationError);
});

/* ── guardToolbox ──────────────────────────────────────────────────────── */

function probeToolbox(): Toolbox {
  return new Toolbox()
    .register(
      "file_read",
      "read a file",
      { path: { type: "string" }, start_line: { type: "integer" } },
      ["path"],
      (args) => `read:${String(args.path)}`,
    )
    .register("echo", "echo", { text: { type: "string" } }, [], (args) => String(args.text ?? ""));
}

test("guard rewrites path args to canonical absolute paths", async () => {
  const g = guardToolbox(probeToolbox(), { root: ws });
  const out = await g.call("file_read", { path: "a/../hello.txt" });
  assert.ok(path.isAbsolute(out.slice("read:".length)), out);
  assert.ok(out.endsWith("hello.txt"), out);
});

test("guard turns path escapes into [ERROR] strings, never throws", async () => {
  const g = guardToolbox(probeToolbox(), { root: ws });
  const out = await g.call("file_read", { path: "../secret.txt" });
  assert.ok(out.startsWith("[ERROR] file_read:"), out);
  assert.ok(out.includes("escapes workspace"), out);
});

test("guard enforces required arguments", async () => {
  const g = guardToolbox(probeToolbox(), { root: ws });
  const out = await g.call("file_read", {});
  assert.ok(out.startsWith("[ERROR] file_read:"), out);
  assert.ok(out.includes(`missing required argument "path"`), out);
});

test("guard caps argument length", async () => {
  const g = guardToolbox(probeToolbox(), { root: ws, maxArgLength: 16 });
  const out = await g.call("echo", { text: "x".repeat(17) });
  assert.ok(out.startsWith("[ERROR] echo:") && out.includes("exceeds 16 characters"), out);
});

test("guard truncates output and marks the cut", async () => {
  const tb = new Toolbox().register("big", "big", {}, [], () => "y".repeat(1000));
  const g = guardToolbox(tb, { root: ws, maxOutputBytes: 100 });
  const out = await g.call("big");
  assert.ok(out.length < 200, String(out.length));
  assert.ok(out.includes("[truncated"), out);
});

test("truncateOutput leaves small payloads untouched", () => {
  const { text, truncated } = truncateOutput("tiny", 64);
  assert.equal(text, "tiny");
  assert.equal(truncated, false);
});

test("guard applies a timeout to runaway handlers", async () => {
  const tb = new Toolbox().register("hang", "hang", {}, [], () => new Promise<string>(() => {}));
  const g = guardToolbox(tb, { root: ws, timeoutMs: 50 });
  const out = await g.call("hang");
  assert.ok(out.startsWith("[ERROR] hang:"), out);
  assert.ok(out.includes("timed out"), out);
});

test("guard writes audit records when enabled", async () => {
  const auditFile = path.join(root, "audit.jsonl");
  const g = guardToolbox(probeToolbox(), { root: ws, audit: auditFile });
  await g.call("echo", { text: "audited" });
  await new Promise((r) => setTimeout(r, 250));
  const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n");
  assert.ok(lines.length >= 1, "no audit line");
  const entry = JSON.parse(lines[lines.length - 1] ?? "{}") as { tool?: string; status?: string };
  assert.equal(entry.tool, "echo");
  assert.equal(entry.status, "ok");
});

/* ── git argument-injection pack (CVE-2025-68144 class) ────────────────── */

test("git tools are argv-exact: shell metacharacters stay literal", async () => {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "guard@test.dev"]);
  git(repo, ["config", "user.name", "guard-test"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "a");

  const tb = new Toolbox();
  registerGitTools(tb, repo, "full");
  const g = guardToolbox(tb, { root: repo });

  const add = await g.call("git_add", { path: "." });
  assert.ok(!add.startsWith("[ERROR]"), add);

  const evil = 'pwn"; touch pwned & echo "done $(uname) `id` %PATH%';
  const commit = await g.call("git_commit", { message: evil });
  assert.ok(!commit.startsWith("[ERROR]"), commit);

  const subject = git(repo, ["log", "-1", "--pretty=%s"]).trim();
  assert.equal(subject, evil, "commit message was altered — injection!");
  assert.equal(fs.existsSync(path.join(repo, "pwned")), false, "injection executed!");
});

test("git ref/remote names reject leading dash and shell characters", async () => {
  const repo = path.join(root, "repo2");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);

  const tb = new Toolbox();
  registerGitTools(tb, repo, "full");
  const g = guardToolbox(tb, { root: repo });

  const dash = await g.call("git_checkout", { branch: "-D" });
  assert.ok(dash.includes('must not start with "-"'), dash);

  const shell = await g.call("git_checkout", { branch: "a;rm -rf" });
  assert.ok(shell.includes("unsupported characters") || shell.includes("[ERROR]"), shell);

  const remote = await g.call("git_push", { remote: "--upload-pack=evil" });
  assert.ok(remote.includes('must not start with "-"'), remote);
});

/* ── exec helpers ──────────────────────────────────────────────────────── */

test("parseCmdShim extracts the node entry from an npm shim", () => {
  const dir = path.join(root, "shim");
  fs.mkdirSync(path.join(dir, "node_modules", "pkg", "dist"), { recursive: true });
  const js = path.join(dir, "node_modules", "pkg", "dist", "cli.js");
  fs.writeFileSync(js, "#!/usr/bin/env node\n");
  const shim = path.join(dir, "pkg.cmd");
  fs.writeFileSync(
    shim,
    `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\pkg\\dist\\cli.js" %*\r\n`,
  );
  const parsed = parseCmdShim(shim);
  assert.ok(parsed, "shim did not parse");
  assert.equal(path.resolve(parsed.script), path.resolve(js));
});

test("parseCmdShim handles the modern npm SET-variable shim (npx-style)", () => {
  const dir = path.join(root, "shim2");
  fs.mkdirSync(path.join(dir, "node_modules", "npm", "bin"), { recursive: true });
  const js = path.join(dir, "node_modules", "npm", "bin", "npx-cli.js");
  fs.writeFileSync(js, "#!/usr/bin/env node\n");
  const helper = path.join(dir, "node_modules", "npm", "bin", "npm-prefix.js");
  fs.writeFileSync(helper, "#!/usr/bin/env node\n");
  const shim = path.join(dir, "npx.cmd");
  fs.writeFileSync(
    shim,
    [
      "@ECHO OFF",
      "SETLOCAL",
      'SET "NODE_EXE=%~dp0\\node.exe"',
      "IF NOT EXIST \"%NODE_EXE%\" (",
      '  SET "NODE_EXE=node"',
      ")",
      'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
      'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
      'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
      "  SET NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js",
      ")",
      'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (',
      '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"',
      ")",
      '"%NODE_EXE%" "%NPX_CLI_JS%" %*',
    ].join("\r\n") + "\r\n",
  );
  const parsed = parseCmdShim(shim);
  assert.ok(parsed, "modern shim did not parse");
  assert.equal(path.resolve(parsed.script), path.resolve(js));
});

test("redactPreview scrubs secrets and caps length", () => {
  const preview = redactPreview({
    token: "abc",
    api_key: "should-hide",
    note: "Bearer abc123def456 some note",
    long: "z".repeat(500),
  });
  assert.ok(!preview.includes("should-hide"), preview);
  assert.ok(!preview.includes("abc123def456"), preview);
  assert.ok(preview.includes("[redacted]"), preview);
  assert.ok(preview.length <= 220, String(preview.length));
});
