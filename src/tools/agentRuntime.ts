/**
 * Agent-runtime tools — native mcp implementations of the 3 tools that were
 * previously explicit stubs:
 *
 *   swarm_spawn   — decompose a task via the gateway LLM, execute sub-tasks in
 *                   parallel with a tool-calling worker loop, score results,
 *                   retry failures once, merge.
 *   shadow_step   — speculative execution on a git shadow branch: branch,
 *                   run the task, run the test command, revert or keep.
 *   war_room      — status summary: workspace git state, active goals, audit
 *                   tail. Read-only, no LLM.
 *
 * The LLM comes from the gateway router (@fraziym/mcp/gateway), so no axoniz
 * peer is required. Tools execute through the host toolbox (workspace-guarded).
 *
 * Probe mode: set FRAZIYM_MCP_PROBE=1 to return a deterministic non-error
 * marker instead of executing (used by `prove` so dispatchability is verified
 * without network/LLM work or branch side effects).
 */

import fs from "node:fs";

import { auditFilePath } from "../core/audit.ts";
import type { Toolbox } from "../core/toolbox.ts";
import type { JsonSchemaProp } from "../core/types.ts";
import { loadGatewayConfig } from "../gateway/config.ts";
import { askRoutedWithHealth, type ChatMessage } from "../gateway/router.ts";
import { ShellTools } from "../impl/shell_tools.ts";

const S = (description: string) => ({ type: "string", description } as const);
const I = (description: string) => ({ type: "integer", description } as const);

/** The 3 live-agent tool names (kept for the lazy host's family mapping). */
export const AGENT_RUNTIME_TOOL_NAMES = [
  "swarm_spawn",
  "shadow_step",
  "war_room",
] as const;

const PROBE = process.env.FRAZIYM_MCP_PROBE === "1";

function probe(name: string): string {
  return `[PROBE] ${name}: dispatchable (LLM execution skipped in probe mode).`;
}

/** Parse a ShellTools.run output into exit code + body (minus the `$ cmd` header). */
function splitRun(out: string): { code: number; text: string } {
  const m = out.match(/\[exit (\d+)\]/);
  const code = m ? Number(m[1]) : 0;
  const text = out.split("\n").slice(1).join("\n").trim();
  return { code, text };
}

/* ── Gateway LLM ──────────────────────────────────────────────────────────── */

/** Chat via the routed provider pool. Throws ProviderError when all fail. */
async function chat(messages: ChatMessage[], temperature?: number): Promise<string> {
  const { config } = loadGatewayConfig();
  const outcome = await askRoutedWithHealth(config, {
    messages,
    ...(temperature !== undefined ? { temperature } : {}),
  });
  return outcome.text;
}

/* ── Tool-calling worker loop ─────────────────────────────────────────────── */

type ToolHandler = (args: Record<string, unknown>) => Promise<string>;
type ToolMap = Record<string, ToolHandler>;

/** Tool prefixes the swarm workers may use (conservative allowlist). */
const WORKER_TOOL_PREFIXES = ["file_", "shell_", "code_", "git_", "web_"];

function buildToolMap(tb: Toolbox): ToolMap {
  const map: ToolMap = {};
  for (const name of tb.names()) {
    if (name === "done") continue;
    if (!WORKER_TOOL_PREFIXES.some((p) => name.startsWith(p))) continue;
    map[name] = async (args) => {
      const r = await tb.call(name, args);
      return typeof r === "string" ? r : JSON.stringify(r);
    };
  }
  return map;
}

const WORKER_SYSTEM =
  "You are a focused worker agent executing one task. " +
  "Use tools to do real work, then finish with: " +
  '<tool>{"name": "done", "args": {"result": "summary of what you did"}}</tool>';

/** Extract <tool>{...}</tool> calls; tolerant of markdown fences in the JSON. */
function parseToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const re = /<tool>\s*([\s\S]*?)\s*<\/tool>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]) as { name?: unknown; args?: unknown };
      if (typeof obj.name === "string") {
        calls.push({
          name: obj.name,
          args: (typeof obj.args === "object" && obj.args !== null ? obj.args : {}) as Record<string, unknown>,
        });
      }
    } catch {
      /* unparseable call — skip */
    }
  }
  return calls;
}

interface WorkerRun {
  result: string;
  steps: number;
}

/** Run one worker: LLM tool-loop until done() or max_steps. */
async function runWorker(
  toolMap: ToolMap,
  task: string,
  opts: { maxSteps?: number; context?: string } = {},
): Promise<WorkerRun> {
  const maxSteps = opts.maxSteps ?? 8;
  const toolNames = Object.keys(toolMap).join(", ");
  const system =
    WORKER_SYSTEM +
    (toolNames ? `\nTools: ${toolNames}` : "\n(No tools available — answer from the task text.)");
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content: opts.context ? `${task}\n\nCONTEXT FROM OTHER WORKERS:\n${opts.context.slice(0, 800)}` : task,
    },
  ];

  let final = "";
  for (let step = 0; step < maxSteps; step++) {
    let full: string;
    try {
      full = await chat(messages, 0.2);
    } catch (err) {
      return { result: `[ERROR] worker llm: ${err instanceof Error ? err.message : String(err)}`, steps: step + 1 };
    }

    const calls = parseToolCalls(full);
    if (calls.length === 0) {
      final = full;
      break;
    }
    messages.push({ role: "assistant", content: full });
    let finished = false;
    for (const c of calls) {
      if (c.name === "done") {
        final = typeof c.args["result"] === "string" ? c.args["result"] : full;
        finished = true;
        break;
      }
      const fn = toolMap[c.name];
      const resultStr = fn
        ? await fn(c.args).catch((e: unknown) => `[ERROR] ${e instanceof Error ? e.message : String(e)}`)
        : `[ERROR] unknown tool '${c.name}'`;
      messages.push({ role: "user", content: `Tool '${c.name}' returned:\n${resultStr}\n\nContinue.` });
    }
    if (finished) break;
  }
  return { result: final || "Worker finished without an explicit result.", steps: maxSteps };
}

/* ── Decompose / schedule / merge ─────────────────────────────────────────── */

const DECOMPOSE_SYSTEM = `Decompose a task into independent parallel sub-tasks.

Rules:
1. Maximize parallelism — only use depends_on for true sequential dependencies
2. Each sub-task is atomic and self-contained
3. Max 8 sub-tasks
4. tool_hint: primary tool (file_write, shell_run, etc.)
5. verify: one-line success check

Respond ONLY with a JSON array:
[
  {"id": 1, "description": "...", "depends_on": [], "priority": 8, "tool_hint": "file_write", "verify": "..."}
]`;

interface SubTaskLite {
  id: number;
  description: string;
  depends_on: number[];
  priority: number;
  verify: string;
  result: string;
  status: "pending" | "done" | "failed";
  steps: number;
}

/** Parse the decomposer's JSON array (tolerates ```json fences). */
function parseSubTasks(text: string): SubTaskLite[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: SubTaskLite[] = [];
  for (const item of raw.slice(0, 8)) {
    const o = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const id = typeof o["id"] === "number" ? o["id"] : out.length + 1;
    const description = typeof o["description"] === "string" ? o["description"] : "";
    if (!description) continue;
    out.push({
      id,
      description,
      depends_on: Array.isArray(o["depends_on"]) ? o["depends_on"].filter((d): d is number => typeof d === "number") : [],
      priority: typeof o["priority"] === "number" ? o["priority"] : 5,
      verify: typeof o["verify"] === "string" ? o["verify"] : "task complete",
      result: "",
      status: "pending",
      steps: 0,
    });
  }
  return out;
}

/** Cheap result scoring (LLM critic is intentionally not used — latency). */
function scoreResult(t: SubTaskLite): number {
  if (t.status === "failed" || t.result.startsWith("[ERROR]")) return 1;
  if (t.result.length < 10) return 2;
  if (t.result.length >= 200) return 7;
  return 5;
}

/** Wave scheduler respecting depends_on with a concurrency cap. */
async function schedule(
  tasks: SubTaskLite[],
  run: (t: SubTaskLite, context: string) => Promise<void>,
  maxWorkers: number,
): Promise<void> {
  const done = new Set<number>(tasks.filter((t) => t.status === "done").map((t) => t.id));
  const pending = tasks.filter((t) => t.status === "pending");
  let guard = 0;
  while (pending.length > 0 && guard++ < 12) {
    const ready = pending.filter((t) => t.depends_on.every((d) => done.has(d)));
    if (ready.length === 0) {
      for (const t of pending) t.status = "failed";
      break;
    }
    const wave = ready.splice(0, Math.max(1, maxWorkers));
    await Promise.all(wave.map((t) => run(t, contextFrom(tasks))));
    for (const t of wave) {
      done.add(t.id);
      const idx = pending.indexOf(t);
      if (idx >= 0) pending.splice(idx, 1);
    }
  }
}

function contextFrom(tasks: SubTaskLite[]): string {
  return tasks
    .filter((t) => t.status === "done")
    .map((t) => `#${t.id}: ${t.result.slice(0, 200)}`)
    .join("\n");
}

function mergeResults(task: string, tasks: SubTaskLite[]): string {
  const passed = tasks.filter((t) => t.status === "done" && scoreResult(t) >= 5);
  if (passed.length === 0) {
    return (
      `Swarm could not complete task: ${task}\n` +
      tasks.map((t) => `  Task ${t.id} [${t.status}]: ${t.result.slice(0, 200)}`).join("\n")
    );
  }
  const failed = tasks.filter((t) => t.status === "failed");
  const lines = passed.map((t) => `── Task ${t.id} ──\n${t.result.slice(0, 1200)}`);
  const head = `[SWARM OK] ${passed.length}/${tasks.length} sub-tasks passed` + (failed.length ? `, ${failed.length} failed` : "");
  return `${head}\n\n${lines.join("\n\n")}`;
}

/* ── Tool registrations ───────────────────────────────────────────────────── */

export interface AgentRuntimeOptions {
  workspace: string;
  /** Shared shell (workspace-guarded). Created on demand when omitted. */
  shell?: ShellTools;
  /** Max parallel swarm workers. Default 3. */
  maxWorkers?: number;
}

export function registerAgentRuntimeTools(tb: Toolbox, opts: AgentRuntimeOptions): void {
  const shell = opts.shell ?? new ShellTools(opts.workspace);
  const maxWorkers = opts.maxWorkers ?? 3;

  tb.register(
    "swarm_spawn",
    "Spawn a swarm of worker agents that decompose a task and execute the sub-tasks in parallel with real tools (gateway LLM).",
    {
      task: S("The task to decompose and execute"),
      workers: I("Max parallel workers (default 3)"),
    },
    ["task"],
    async (args) => {
      const task = typeof args["task"] === "string" ? args["task"] : "";
      if (!task.trim()) return "[ERROR] swarm_spawn: task is required";
      if (PROBE) return probe("swarm_spawn");

      let plan: SubTaskLite[];
      try {
        const raw = await chat(
          [
            { role: "system", content: DECOMPOSE_SYSTEM },
            { role: "user", content: task },
          ],
          0.1,
        );
        plan = parseSubTasks(raw);
        if (plan.length === 0) {
          // Decomposer gave nothing runnable — run as a single direct task.
          plan = [{ id: 1, description: task, depends_on: [], priority: 5, verify: "task complete", result: "", status: "pending", steps: 0 }];
        }
      } catch (err) {
        return `[ERROR] swarm_spawn: ${err instanceof Error ? err.message : String(err)}`;
      }

      const toolMap = buildToolMap(tb);
      const runOne = async (t: SubTaskLite, context: string): Promise<void> => {
        t.status = "pending";
        const w = await runWorker(toolMap, `${t.description}\n\nSuccess criterion: ${t.verify}`, {
          context,
          maxSteps: 8,
        });
        t.result = w.result;
        t.steps = w.steps;
        t.status = w.result.startsWith("[ERROR]") ? "failed" : "done";
      };

      const cap = typeof args["workers"] === "number" && args["workers"] > 0 ? args["workers"] : maxWorkers;
      await schedule(plan, runOne, cap);

      // One retry for failures (cheap — single re-run).
      const failed = plan.filter((t) => t.status === "failed");
      for (const t of failed) await runOne(t, contextFrom(plan));

      return mergeResults(task, plan);
    },
    { destructive: true },
  );

  tb.register(
    "shadow_step",
    "Speculative execution: run the task on a temporary git shadow branch, verify with a test command, then revert (or keep the branch on success).",
    {
      task: S("The task to execute speculatively"),
      test_cmd: S("Command that decides pass/fail (default: echo ok)"),
    },
    ["task"],
    async (args) => {
      const task = typeof args["task"] === "string" ? args["task"] : "";
      const testCmd = typeof args["test_cmd"] === "string" && args["test_cmd"] ? args["test_cmd"] : "echo ok";
      if (!task.trim()) return "[ERROR] shadow_step: task is required";
      if (PROBE) return probe("shadow_step");

      const branchId = Math.random().toString(16).slice(2, 8);
      const shadowBranch = `shadow/${branchId}`;

      const origRun = splitRun(await shell.run("git rev-parse --abbrev-ref HEAD").catch(() => ""));
      const orig = origRun.code === 0 ? origRun.text : "";
      if (!orig) {
        return "[ERROR] shadow_step: not a git workspace";
      }
      const createRun = splitRun(await shell.run(`git checkout -b ${shadowBranch}`).catch(() => ""));
      if (createRun.code !== 0) {
        return `[ERROR] shadow_step: cannot create ${shadowBranch}: ${createRun.text.slice(0, 200)}`;
      }

      try {
        const toolMap = buildToolMap(tb);
        const w = await runWorker(toolMap, task, { maxSteps: 10 });
        const testRun = splitRun(await shell.run(testCmd, 300).catch(() => "[exit 1]"));
        const failed =
          testRun.code !== 0 ||
          w.result.startsWith("[ERROR]") ||
          testRun.text.toLowerCase().includes("failed");
        if (!failed) {
          await shell.run(`git checkout ${orig}`).catch(() => "");
          return (
            `[SHADOW SUCCESS] Task completed and verified in ${shadowBranch}.\n` +
            `Result: ${w.result.slice(0, 500)}\n` +
            `Tests: ${testRun.text.slice(0, 300)}\n` +
            `Action: 'git merge ${shadowBranch}' to apply, or 'git branch -D ${shadowBranch}' to discard.`
          );
        }
        await shell.run(`git checkout ${orig}`).catch(() => "");
        return `[SHADOW FAILED] Speculative execution failed verification:\n${testRun.text.slice(0, 500)}`;
      } catch (err) {
        await shell.run(`git checkout ${orig}`).catch(() => "");
        return `[SHADOW ERROR] ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    { destructive: true },
  );

  tb.register(
    "war_room",
    "Status summary for the workspace: git state, active goals, and the tool-audit tail. Read-only, no LLM.",
    {},
    [],
    async () => {
      const lines: string[] = ["[War Room] Status: STANDALONE (no daemon attached)"];

      const branchRun = splitRun(await shell.run("git rev-parse --abbrev-ref HEAD").catch(() => ""));
      if (branchRun.code === 0 && branchRun.text) {
        lines.push(`  Branch: ${branchRun.text}`);
        const statusRun = splitRun(await shell.run("git status --porcelain").catch(() => ""));
        const dirty = statusRun.text ? statusRun.text.split("\n").length : 0;
        lines.push(`  Uncommitted changes: ${dirty}`);
      } else {
        lines.push("  Workspace: not a git repository (or git unavailable)");
      }

      // Active goals (optional peer).
      try {
        const mod = (await import("@fraziym/axoniz/goals" as string)) as Record<string, unknown>;
        const get = mod.getGoalService as (() => { count(status?: string): number }) | undefined;
        if (typeof get === "function") {
          lines.push(`  Active goals: ${get().count("active")}`);
        }
      } catch {
        lines.push("  Active goals: (peer @fraziym/axoniz not installed)");
      }

      // Audit tail.
      try {
        const audit = auditFilePath();
        if (fs.existsSync(audit)) {
          const raw = fs.readFileSync(audit, "utf-8").trim().split("\n").filter(Boolean);
          const tail = raw.slice(-3);
          lines.push(`  Audit events: ${raw.length} total, last ${tail.length}:`);
          for (const line of tail) lines.push(`    ${line.slice(0, 140)}`);
        } else {
          lines.push("  Audit: (no events recorded)");
        }
      } catch {
        lines.push("  Audit: (unreadable)");
      }

      return lines.join("\n");
    },
    { readOnly: true },
  );
}

/** Backwards-compat: names + schemas unchanged, handlers now real. */
export const STUB_TOOL_NAMES = AGENT_RUNTIME_TOOL_NAMES;
export type { JsonSchemaProp };
