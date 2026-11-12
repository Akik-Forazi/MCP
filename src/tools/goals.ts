/**
 * Goal tools — binds axoniz `GoalService` (the goals subsystem) to the 7
 * goal_* tools of the axoniz 72 that were previously explicit stubs.
 *
 * Optional peer pattern (same as memory.ts): mcp does NOT hard-depend on
 * `@fraziym/axoniz`. Handlers lazily import `@fraziym/axoniz/goals`; when the
 * peer is missing they return the same explicit `[ERROR]` stub message so
 * standalone behavior is unchanged.
 *
 * The GoalService derives its DB path from AXONIZ_HOME (`$FRAZIYM_HOME/axoniz`
 * or `~/.fraziym/axoniz/goals.db`), so goal tools share state with the axoniz
 * agent/CLI when both run under the same FRAZIYM_HOME.
 */

import type { Toolbox } from "../core/toolbox.ts";
import type { JsonSchemaProp } from "../core/types.ts";

/** The 7 goal-family tool names now bound to GoalService. */
export const GOAL_TOOL_NAMES = [
  "goal_create",
  "goal_list",
  "goal_kr_add",
  "goal_action_add",
  "goal_update_score",
  "goal_action_complete",
  "goal_report",
] as const;

const S = (description: string) => ({ type: "string", description } as const);
const N = (description: string) => ({ type: "number", description } as const);

function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Same wording as stubs.ts so absent-peer output stays recognizable. */
function stub(name: string): string {
  return `[ERROR] ${name}: requires the axoniz agent runtime (not standalone-exportable from @fraziym/axoniz yet). Use the axoniz agent/CLI for this capability.`;
}

/** Lazily resolve the axoniz GoalService; throws a stub-style error when absent. */
async function goalService(): Promise<Record<string, (...a: unknown[]) => unknown>> {
  try {
    const mod = (await import("@fraziym/axoniz/goals" as string)) as Record<string, unknown>;
    const get = (mod.getGoalService ?? mod.get_goal_service) as
      | (() => unknown)
      | undefined;
    if (typeof get !== "function") throw new Error("no getGoalService export");
    return get() as Record<string, (...a: unknown[]) => unknown>;
  } catch {
    throw new Error("GOAL_PEER_MISSING");
  }
}

function strArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

/** Render goals as a compact human-readable list (never empty-string). */
function formatGoals(goals: Array<Record<string, unknown>>): string {
  if (!Array.isArray(goals) || goals.length === 0) {
    return "Active Goals:\n  (none)";
  }
  const lines: string[] = [];
  for (const g of goals.slice(0, 10)) {
    const deadline = typeof g.deadline === "string" && g.deadline ? ` (due ${g.deadline})` : "";
    const score = typeof g.score === "number" ? `${Math.round(g.score)}%` : "?";
    lines.push(`  [${score}] ${String(g.title ?? "(untitled)")}${deadline}`);
  }
  return "Active Goals:\n" + lines.join("\n");
}

export function registerGoalTools(tb: Toolbox): void {
  const DESTRUCTIVE = new Set([
    "goal_create",
    "goal_kr_add",
    "goal_action_add",
    "goal_update_score",
    "goal_action_complete",
  ]);

  const bind = (
    name: string,
    description: string,
    props: Record<string, JsonSchemaProp>,
    required: string[],
    run: (svc: Record<string, (...a: unknown[]) => unknown>, args: Record<string, unknown>) => unknown,
  ): void => {
    tb.register(
      name,
      description,
      props,
      required,
      async (args) => {
        let svc: Record<string, (...a: unknown[]) => unknown>;
        try {
          svc = await goalService();
        } catch {
          return stub(name);
        }
        try {
          return toStr(run(svc, args));
        } catch (err) {
          return `[ERROR] ${name}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      DESTRUCTIVE.has(name) ? { destructive: true } : { readOnly: true },
    );
  };

  bind(
    "goal_create",
    "Create a new goal.",
    {
      title: S("Goal title"),
      description: S("Goal description"),
      deadline: S("Deadline (ISO date)"),
      priority: S('Priority: "low" | "medium" | "high"'),
    },
    ["title"],
    (svc, args) =>
      svc.create_goal(
        strArg(args, "title"),
        strArg(args, "description"),
        strArg(args, "deadline"),
        strArg(args, "priority", "high"),
      ),
  );

  bind(
    "goal_list",
    "List goals.",
    { status: S('Filter by status (e.g. "active", "done")') },
    [],
    (svc, args) => formatGoals(svc.list_goals(strArg(args, "status", "active")) as Array<Record<string, unknown>>),
  );

  bind(
    "goal_kr_add",
    "Add a key result to a goal.",
    { goal_id: S("Target goal id"), title: S("Key result title"), target: S("Target value/description") },
    ["goal_id", "title"],
    (svc, args) => svc.add_key_result(strArg(args, "goal_id"), strArg(args, "title"), strArg(args, "target")),
  );

  bind(
    "goal_action_add",
    "Schedule an action under a key result.",
    { kr_id: S("Target key-result id"), title: S("Action title"), scheduled_date: S("Scheduled date (ISO)") },
    ["kr_id", "title"],
    (svc, args) =>
      svc.add_daily_action(strArg(args, "kr_id"), strArg(args, "title"), strArg(args, "scheduled_date")),
  );

  bind(
    "goal_update_score",
    "Update a goal's progress score.",
    {
      goal_id: S("Target goal id"),
      score: N("Progress score (0-100)"),
      key_result_id: S("Optional key-result id to scope the score"),
    },
    ["goal_id", "score"],
    (svc, args) => {
      const score = typeof args.score === "number" ? args.score : Number(args.score ?? 0);
      const krId = strArg(args, "key_result_id");
      return svc.update_score(strArg(args, "goal_id"), score, krId || null);
    },
  );

  bind(
    "goal_action_complete",
    "Mark a goal action complete.",
    { action_id: S("Action id to complete") },
    ["action_id"],
    (svc, args) => svc.complete_action(strArg(args, "action_id")),
  );

  bind(
    "goal_report",
    "Generate a goal progress report.",
    { goal_id: S("Goal id (optional — all goals when omitted)") },
    [],
    (svc) => {
      const fn = svc.daily_report ?? svc.morning_plan;
      if (typeof fn !== "function") throw new Error("GoalService has no daily_report");
      return fn.call(svc);
    },
  );
}
