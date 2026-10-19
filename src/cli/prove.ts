/**
 * `fraziym-mcp prove` — dispatch every catalog tool once in a throwaway
 * workspace and classify the outcome. Proves the whole toolbelt is wired:
 * any `Unknown tool` response fails the run; environment-dependent errors
 * (missing axodex CLI/index, agent-runtime stubs, no display, git remotes)
 * are reported but expected.
 *
 * Writes prove-report.json (path via --out) as a release artifact.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { execCapture } from "../core/exec.ts";
import { LazyToolHost } from "../core/host.ts";
import { STUB_TOOL_NAMES } from "../tools/stubs.ts";

export interface ProveOptions {
  out: string;
  /** Also dispatch desktop-input tools (moves the real cursor). Default false. */
  includeInput: boolean;
}

interface CaseResult {
  name: string;
  status: "ok" | "stub" | "axodex" | "env-error" | "desktop-skipped" | "unreachable";
  ms: number;
  message?: string;
}

const DESKTOP_PREFIXES = ["screen_", "mouse_", "keyboard_", "key_press"];

const STRING_VALUES: Record<string, string> = {
  path: "prove.txt",
  filename: "prove_capture.txt",
  url: "http://127.0.0.1:1/",
  command: "echo prove",
  test_cmd: "echo prove",
  code: "print('prove')",
  content: "prove content\nPROVE_TOKEN\n",
  old: "PROVE_TOKEN",
  new: "PROVE_PATCHED",
  patch: "@@ -1,2 +1,2 @@\n prove content\n-PROVE_TOKEN\n+PROVE_PATCHED\n",
  query: "prove",
  pattern: "prove",
};

function valueFor(key: string, type: string | undefined): unknown {
  const special = STRING_VALUES[key];
  if (special !== undefined) return special;
  if (type === "integer" || type === "number") return 1;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return {};
  return "prove";
}

function argsFor(
  schema: { properties?: Record<string, { type?: string }>; required?: string[] },
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    args[key] = valueFor(key, schema.properties?.[key]?.type);
  }
  return args;
}

function classify(name: string, result: string): CaseResult["status"] {
  if (!result.startsWith("[ERROR]")) return "ok";
  if (result.includes("Unknown tool")) return "unreachable";
  if (result.includes("requires the axoniz agent runtime")) return "stub";
  if (result.startsWith("[AXODEX ERROR]") || result.includes("[AXODEX ERROR]")) return "axodex";
  return "env-error";
}

export async function prove(opts: ProveOptions): Promise<number> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fraziym-mcp-prove-"));
  fs.writeFileSync(path.join(root, "prove.txt"), "prove content\nPROVE_TOKEN\n");

  try {
    const git = await execCapture("git", ["init", "--quiet"], { cwd: root, timeoutMs: 30_000 });
    if (!git.spawnError) {
      await execCapture("git", ["config", "user.email", "prove@fraziym.local"], { cwd: root, timeoutMs: 10_000 });
      await execCapture("git", ["config", "user.name", "prove"], { cwd: root, timeoutMs: 10_000 });
    }

    const host = new LazyToolHost({
      workspace: root,
      group: "all",
      guard: { audit: false, timeoutMs: 20_000 },
      memoryPaths: {
        palace_path: path.join(root, ".axoniz", "palace"),
        kg_path: path.join(root, ".axoniz", "kg"),
      },
    });

    const results: CaseResult[] = [];
    for (const spec of host.specs()) {
      const name = spec.function.name;
      if (!opts.includeInput && DESKTOP_PREFIXES.some((p) => name.startsWith(p))) {
        results.push({ name, status: "desktop-skipped", ms: 0 });
        continue;
      }
      const params = spec.function.parameters as {
        properties?: Record<string, { type?: string }>;
        required?: string[];
      };
      const started = Date.now();
      let out: string;
      try {
        out = await host.call(name, argsFor(params));
      } catch (e) {
        out = `[ERROR] Unknown tool: ${name} (${e instanceof Error ? e.message : String(e)})`;
      }
      const status = classify(name, out);
      results.push({
        name,
        status,
        ms: Date.now() - started,
        ...(status === "ok" ? {} : { message: out.split("\n")[0]?.slice(0, 180) }),
      });
    }

    const counts = { total: results.length } as Record<string, number>;
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const failed = results.filter((r) => r.status === "unreachable");

    const report = {
      generatedAt: new Date().toISOString(),
      workspace: root,
      stubs: [...STUB_TOOL_NAMES],
      counts,
      results,
    };
    fs.writeFileSync(path.resolve(opts.out), `${JSON.stringify(report, null, 2)}\n`);

    for (const r of results) {
      if (r.status === "env-error") process.stdout.write(`  env-error   ${r.name}: ${r.message ?? ""}\n`);
      if (r.status === "unreachable") process.stdout.write(`  UNREACHABLE ${r.name}\n`);
    }
    process.stdout.write(
      `prove: ${String(counts.total)} tools — ` +
        `${String(counts.ok ?? 0)} ok, ${String(counts.stub ?? 0)} agent-runtime stubs, ` +
        `${String(counts.axodex ?? 0)} axodex-env, ${String(counts["env-error"] ?? 0)} env errors, ` +
        `${String(counts["desktop-skipped"] ?? 0)} desktop-skipped, ` +
        `${String(counts.unreachable ?? 0)} unreachable\n` +
        `report: ${path.resolve(opts.out)}\n`,
    );
    return failed.length > 0 ? 1 : 0;
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* sqlite handles may linger on Windows */
    }
  }
}
