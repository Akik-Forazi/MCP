/**
 * Agent-runtime stubs — the 10 axoniz tools whose logic lives in the agent
 * runtime (goals service, swarm, war room, shadow verification). Names and
 * schemas mirror axoniz `tool_schemas.ts`; handlers return explicit `[ERROR]`
 * strings until axoniz exposes those subsystems as standalone imports.
 */

import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

/** The 10 agent-runtime tool names (used by the lazy host's family mapping). */
export const STUB_TOOL_NAMES = [
  "swarm_spawn",
  "shadow_step",
  "war_room",
  "goal_create",
  "goal_list",
  "goal_kr_add",
  "goal_action_add",
  "goal_update_score",
  "goal_action_complete",
  "goal_report",
] as const;

function stub(name: string): string {
  return `[ERROR] ${name}: requires the axoniz agent runtime (not standalone-exportable from @fraziym/axoniz yet). Use the axoniz agent/CLI for this capability.`;
}

export function registerStubTools(tb: Toolbox): void {
  tb.register(
    "swarm_spawn",
    "Spawn parallel worker agents in isolated git worktrees.",
    { task: S("Task for the swarm"), workers: I("Worker count (default 4)"), base_branch: S("Base branch to fork from") },
    ["task"],
    () => stub("swarm_spawn"),
    { destructive: true },
  );

  tb.register(
    "shadow_step",
    "Run a shadow verification step (propose → test → measure diff).",
    { task: S("Task to verify"), test_cmd: S("Command that decides pass/fail") },
    ["task"],
    () => stub("shadow_step"),
    { destructive: true },
  );

  tb.register(
    "war_room",
    "Convene the multi-agent war room to debate a decision.",
    { topic: S("Topic to debate") },
    ["topic"],
    () => stub("war_room"),
  );

  tb.register(
    "goal_create",
    "Create a new goal.",
    {
      title: S("Goal title"),
      description: S("Goal description"),
      deadline: S("Deadline (ISO date)"),
      priority: S('Priority: "low" | "medium" | "high"'),
    },
    ["title"],
    () => stub("goal_create"),
    { destructive: true },
  );

  tb.register(
    "goal_list",
    "List goals.",
    { status: S('Filter by status (e.g. "active", "done")') },
    [],
    () => stub("goal_list"),
  );

  tb.register(
    "goal_kr_add",
    "Add a key result to a goal.",
    { goal_id: S("Target goal id"), title: S("Key result title"), target: S("Target value/description") },
    ["goal_id", "title"],
    () => stub("goal_kr_add"),
    { destructive: true },
  );

  tb.register(
    "goal_action_add",
    "Schedule an action under a key result.",
    { kr_id: S("Target key-result id"), title: S("Action title"), scheduled_date: S("Scheduled date (ISO)") },
    ["kr_id", "title"],
    () => stub("goal_action_add"),
    { destructive: true },
  );

  tb.register(
    "goal_update_score",
    "Update a goal's progress score.",
    { goal_id: S("Target goal id"), score: { type: "number", description: "Progress score (0-100)" } },
    ["goal_id", "score"],
    () => stub("goal_update_score"),
    { destructive: true },
  );

  tb.register(
    "goal_action_complete",
    "Mark a goal action complete.",
    { action_id: S("Action id to complete") },
    ["action_id"],
    () => stub("goal_action_complete"),
    { destructive: true },
  );

  tb.register(
    "goal_report",
    "Generate a goal progress report.",
    { goal_id: S("Goal id (optional — all goals when omitted)") },
    [],
    () => stub("goal_report"),
  );
}
