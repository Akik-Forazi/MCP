/**
 * Gateway toolbox — the custom endpoints shipped with fraziym-mcp:
 *
 *   router/*  ask · race · delegate · status      (provider pools + failover)
 *   fix/*     verify · shadow · queue.pull · queue.complete
 *   brain/*   absolute · pack · remember
 *   tools/discover · audit/tail
 *
 * Exposed as MCP tools with underscore names (MCP tool names must be
 * [A-Za-z0-9_-]); grouped under the "gateway" family and only advertised when
 * `serve --router-tools` is passed, so the default catalog stays at 74.
 */

import fs from "node:fs";
import path from "node:path";

import { argBool, argInt, argStr } from "../core/args.ts";
import { auditFilePath } from "../core/audit.ts";
import { loadCatalog } from "../core/catalog.ts";
import type { FamilyContext } from "../core/families.ts";
import { Toolbox } from "../core/toolbox.ts";
import type { JsonSchemaProp } from "../core/types.ts";
import { apiKeyOf, loadGatewayConfig, type GatewayConfig } from "./config.ts";
import { queueComplete, queuePull, runShadow, runVerify, type ShadowFile } from "./fix.ts";
import { askRouted, pickProviders, providersForModel, raceModels, type ChatOutcome, type ChatMessage } from "./router.ts";

const S = (description: string) => ({ type: "string", description });
const N = (description: string) => ({ type: "number", description });

const PACK_BUDGET = 16 * 1024;

export interface GatewayDeps {
  workspace: string;
  /** Per-product state dir (audit/queue), default ~/.fraziym/mcp. */
  home: string;
  /** Shared Fraziym config dir (~/.fraziym) — config.json is read from here. */
  configHome?: string;
  ctx: FamilyContext;
}

export function gatewayToolNames(): string[] {
  return [...GATEWAY_TOOL_NAMES];
}

export const GATEWAY_TOOL_NAMES = [
  "router_ask",
  "router_race",
  "router_delegate",
  "router_status",
  "fix_verify",
  "fix_shadow",
  "fix_queue_pull",
  "fix_queue_complete",
  "brain_absolute",
  "brain_pack",
  "brain_remember",
  "tools_discover",
  "audit_tail",
] as const;

const GATEWAY_SET = new Set<string>(GATEWAY_TOOL_NAMES);

export function isGatewayTool(name: string): boolean {
  return GATEWAY_SET.has(name);
}

function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function outcomeLine(outcome: ChatOutcome): string {
  return `${outcome.provider} · ${outcome.model} · ${String(outcome.ms)}ms`;
}

function messages(args: Record<string, unknown>, systemKey = "system"): ChatMessage[] {
  const system = argStr(args, systemKey).trim();
  const prompt = argStr(args, "prompt").trim() || argStr(args, "task").trim();
  const list: ChatMessage[] = [];
  if (system) list.push({ role: "system", content: system });
  list.push({ role: "user", content: prompt });
  return list;
}

function systemMessages(args: Record<string, unknown>): ChatMessage[] {
  const system = argStr(args, "system").trim();
  return system ? [{ role: "system", content: system }] : [];
}

function routerStatus(config: GatewayConfig): string {
  const routing = config.routing ?? {};
  const lines = [
    `providers: ${String(config.providers.length)}`,
    ...config.providers.map((p) => {
      const key = apiKeyOf(p) ? "key:present" : "key:MISSING";
      const models = (p.models ?? []).slice(0, 4).join(", ") || "(any model id)";
      return `  ${p.name} [${p.kind}] ${p.baseUrl} — ${key} — ${models}`;
    }),
    `routing.default: ${routing.default ?? "(first provider)"}`,
    `routing.byModelPrefix: ${Object.entries(routing.byModelPrefix ?? {})
      .map(([prefix, provider]) => `${prefix}→${provider}`)
      .join(", ") || "(none)"}`,
    `verify commands: ${(config.verify ?? []).map((v) => v.name).join(", ") || "(none)"}`,
  ];
  return lines.join("\n");
}

function parseShadowFiles(args: Record<string, unknown>): ShadowFile[] {
  const raw = args["files"];
  if (!Array.isArray(raw)) return [];
  const files: ShadowFile[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const filePath = typeof record.path === "string" ? record.path : "";
    const content = typeof record.content === "string" ? record.content : "";
    if (filePath && content) files.push({ path: filePath, content });
  }
  return files;
}

function workspaceTree(root: string, maxEntries = 80, depth = 2): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string, level: number): void => {
    if (lines.length >= maxEntries || level > depth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries
      .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= maxEntries) return;
      lines.push(`${prefix}${entry.isDirectory() ? "📁" : "·"} ${entry.name}`);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}  `, level + 1);
    }
  };
  walk(root, "", 1);
  if (lines.length === 0) return "(empty workspace)";
  return lines.join("\n") + (lines.length >= maxEntries ? "\n… (truncated)" : "");
}

function scoreTool(tool: { name: string; description: string }, tokens: string[]): number {
  let score = 0;
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  for (const token of tokens) {
    if (name === token) score += 40;
    else if (name.includes(token)) score += 12;
    if (description.includes(token)) score += 4;
  }
  return score;
}

function auditTail(lines: number, toolFilter: string): string {
  const file = auditFilePath();
  if (!fs.existsSync(file)) return `[EMPTY] no audit log at ${file}`;
  const all = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
  let selected = all;
  if (toolFilter) {
    selected = all.filter((line) => {
      try {
        return (JSON.parse(line) as { tool?: string }).tool === toolFilter;
      } catch {
        return false;
      }
    });
  }
  const tail = selected.slice(-lines);
  if (tail.length === 0) return `[EMPTY] no audit entries${toolFilter ? ` for tool '${toolFilter}'` : ""} (${String(all.length)} total)`;
  return `${String(tail.length)} of ${String(all.length)} entries from ${file}\n${tail.join("\n")}`;
}

export function buildGatewayToolbox(deps: GatewayDeps): Toolbox {
  const tb = new Toolbox();
  const loadConfig = (): GatewayConfig => loadGatewayConfig(deps.configHome).config;

  tb.register(
    "router_status",
    "Gateway: show configured LLM providers, key presence (never key material), routing rules and verify commands.",
    {},
    [],
    () => routerStatus(loadConfig()),
    { readOnly: true },
  );

  tb.register(
    "router_ask",
    "Gateway: send a prompt to the routed LLM provider pool with automatic failover across providers.",
    {
      prompt: S("The user message to send"),
      model: S("Optional model id; routing.byModelPrefix decides the provider"),
      system: S("Optional system prompt"),
      temperature: N("Optional sampling temperature"),
    },
    ["prompt"],
    async (args) => {
      const temperature = args["temperature"];
      const outcome = await askRouted(loadConfig(), {
        messages: messages(args),
        ...(argStr(args, "model") ? { model: argStr(args, "model") } : {}),
        ...(typeof temperature === "number" ? { temperature } : {}),
      });
      return `${outcome.text}\n\n— router_ask via ${outcomeLine(outcome)}`;
    },
    { network: true },
  );

  tb.register(
    "router_race",
    "Gateway: race the same prompt across several models; returns the first successful completion.",
    {
      prompt: S("The user message to send"),
      models: S("Comma-separated model ids to race"),
      system: S("Optional system prompt"),
    },
    ["prompt", "models"],
    async (args) => {
      const models = argStr(args, "models")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean);
      if (models.length < 2) return "[ERROR] router_race needs at least two models";
      const outcome = await raceModels(loadConfig(), models, { messages: messages(args) });
      return `${outcome.text}\n\n— router_race won by ${outcomeLine(outcome)} of ${String(models.length)} racers`;
    },
    { network: true },
  );

  tb.register(
    "router_delegate",
    "Gateway: delegate a task to one specific model (picked by exact/suffix match against provider model lists, prefix routing, or the default pool).",
    {
      task: S("The task text to delegate"),
      model: S("Model id to delegate to"),
      system: S("Optional system prompt"),
    },
    ["task", "model"],
    async (args) => {
      const config = loadConfig();
      const model = argStr(args, "model");
      const exact = providersForModel(config, model);
      const chain = exact.length > 0 ? exact : pickProviders(config, model);
      const outcome = await askRouted(
        config,
        { messages: systemMessages(args).concat({ role: "user", content: argStr(args, "task") }), model },
        { providers: chain },
      );
      return `${outcome.text}\n\n— router_delegate to ${outcomeLine(outcome)}`;
    },
    { network: true },
  );

  tb.register(
    "fix_verify",
    "Gateway: run the configured verify commands (npm test, lint, …) in the workspace and report pass/fail with output tails.",
    { name: S("Optional single verify command name from config (default: all)") },
    [],
    (args) => runVerify(loadConfig(), deps.workspace, argStr(args, "name") || undefined),
  );

  tb.register(
    "fix_shadow",
    "Gateway: apply candidate file contents in a throwaway git worktree, run test_cmd there, and report the result — the workspace is never modified.",
    {
      test_cmd: S("Shell command to run in the shadow worktree (e.g. \"npm test\")"),
      files: {
        type: "array",
        description: "Candidate files: [{path, content}] — paths are jailed inside the worktree",
        items: { type: "object", properties: { path: S("Relative file path"), content: S("Full new file content") } } as unknown as JsonSchemaProp,
      } as unknown as JsonSchemaProp,
    },
    ["test_cmd", "files"],
    (args) => runShadow(deps.workspace, parseShadowFiles(args), argStr(args, "test_cmd")),
  );

  tb.register(
    "fix_queue_pull",
    "Gateway: pull the next pending item from the fix queue (~/.fraziym/mcp/fix-queue.jsonl).",
    {},
    [],
    () => queuePull(deps.home),
  );

  tb.register(
    "fix_queue_complete",
    "Gateway: mark a fix queue item complete or failed (append-only event).",
    { id: S("Queue item id"), ok: { type: "boolean", description: "true = fixed, false = failed" } as JsonSchemaProp, note: S("Optional note") },
    ["id"],
    (args) => queueComplete(deps.home, argStr(args, "id"), argBool(args, "ok", true), argStr(args, "note") || undefined),
  );

  tb.register(
    "brain_absolute",
    "Gateway: absolute query — search BOTH the codebase (axodex) and long-term memory (palace) and return combined results.",
    { query: S("Concept, symbol, or question to search for") },
    ["query"],
    async (args) => {
      const query = argStr(args, "query");
      const mem = await deps.ctx.memory();
      const handlers = mem.as_tool_map() as unknown as Record<string, (a: Record<string, unknown>) => unknown>;
      const palaceSearch = handlers["palace_search"];
      const [codeText, memText] = await Promise.all([
        deps.ctx.axodex().query(query),
        Promise.resolve(palaceSearch ? palaceSearch({ query }) : ""),
      ]);
      return `══ Axodex (code graph) ══\n${toStr(codeText)}\n\n══ Palace (long-term memory) ══\n${toStr(memText)}`;
    },
    { readOnly: true },
  );

  tb.register(
    "brain_pack",
    "Gateway: assemble a context pack for a task — matching code (axodex), matching memory (palace), and a workspace overview — capped to a token budget.",
    { task: S("Task description to pack context for") },
    ["task"],
    async (args) => {
      const task = argStr(args, "task");
      const mem = await deps.ctx.memory();
      const handlers = mem.as_tool_map() as unknown as Record<string, (a: Record<string, unknown>) => unknown>;
      const palaceSearch = handlers["palace_search"];
      const [code, memory] = await Promise.all([
        deps.ctx.axodex().query(task).catch((err: unknown) => `[axodex unavailable: ${err instanceof Error ? err.message : String(err)}]`),
        Promise.resolve(palaceSearch ? palaceSearch({ query: task }) : ""),
      ]);
      let pack = [
        `# Context pack for: ${task}`,
        "## Workspace overview",
        workspaceTree(deps.workspace),
        "## Code graph matches (axodex)",
        toStr(code),
        "## Memory matches (palace)",
        toStr(memory),
      ].join("\n\n");
      if (pack.length > PACK_BUDGET) {
        pack = `${pack.slice(0, PACK_BUDGET)}\n… (pack truncated at ${String(PACK_BUDGET)} chars)`;
      }
      return pack;
    },
    { readOnly: true },
  );

  tb.register(
    "brain_remember",
    "Gateway: save a durable memory (palace) entry; thin alias over memory_save with brain-prefixed keys.",
    { text: S("What to remember"), kind: S("Optional category tag, e.g. 'decision' or 'fact'") },
    ["text"],
    async (args) => {
      const text = argStr(args, "text");
      if (!text.trim()) return "[ERROR] brain_remember: 'text' is required";
      const kind = argStr(args, "kind", "note");
      const mem = await deps.ctx.memory();
      const handlers = mem.as_tool_map() as unknown as Record<string, (a: Record<string, unknown>) => unknown>;
      const save = handlers["memory_save"];
      if (!save) return "[ERROR] memory_save handler unavailable";
      const key = `brain_${kind}_${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const result = await save({ key, value: text });
      return `[REMEMBERED] ${key}\n${toStr(result)}`;
    },
  );

  tb.register(
    "tools_discover",
    "Gateway: rank catalog tools by keyword relevance to a task — find the right tool without loading all 74 schemas.",
    { query: S("What you want to do, e.g. 'read a file' or 'git diff'"), limit: N("Max results (default 8)") },
    ["query"],
    (args) => {
      const query = argStr(args, "query").toLowerCase();
      const tokens = query.split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
      if (tokens.length === 0) return "[ERROR] tools_discover: query must contain words";
      const catalog = loadCatalog();
      const tools = catalog?.tools ?? [];
      const ranked = tools
        .map((tool) => ({ tool, score: scoreTool(tool, tokens) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .slice(0, Math.max(1, argInt(args, "limit", 8)));
      if (ranked.length === 0) return `No catalog tool matches '${query}' (${String(tools.length)} tools searched).`;
      return ranked
        .map(({ tool, score }) => `${tool.name} [${tool.groups.join("+")}] (score ${String(score)})\n    ${tool.description}`)
        .join("\n");
    },
    { readOnly: true },
  );

  tb.register(
    "audit_tail",
    "Gateway: tail the local audit log (~/.fraziym/mcp/audit.jsonl) — redacted call records, newest last.",
    { lines: N("How many entries (default 20)"), tool: S("Optional tool name filter") },
    [],
    (args) => auditTail(Math.max(1, argInt(args, "lines", 20)), argStr(args, "tool")),
    { readOnly: true },
  );

  return tb;
}
