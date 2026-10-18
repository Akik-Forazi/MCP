/**
 * Long-term memory tools — binds axoniz `UnifiedMemory` (plain key-value +
 * palace + knowledge graph + diary layers) to the 20 memory-family tools of
 * the axoniz 72.
 *
 * Schemas are taken verbatim from axoniz (`as_tool_schemas()`); the three
 * plain key-value tools are declared here because axoniz only ships schemas
 * for its layered backends. `palace_status` exists on the handler map but is
 * not advertised in the axoniz 72, so it is not registered.
 */

import type { UnifiedMemory } from "@fraziym/axoniz/memory";

import type { Toolbox } from "../core/toolbox.ts";
import type { ToolFunctionSchema } from "../core/types.ts";

const S = (description: string) => ({ type: "string", description });

/** The exact 20 memory-family tool names of the axoniz 72. */
export const MEMORY_TOOL_NAMES = [
  "memory_save",
  "memory_get",
  "memory_list",
  "palace_search",
  "palace_store",
  "palace_context",
  "palace_wings",
  "palace_rooms",
  "palace_check_dup",
  "palace_delete",
  "palace_graph_traverse",
  "palace_find_tunnels",
  "palace_graph_stats",
  "kg_add",
  "kg_query",
  "kg_invalidate",
  "kg_timeline",
  "kg_stats",
  "diary_write",
  "diary_read",
] as const;

const DESTRUCTIVE = new Set([
  "memory_save",
  "palace_store",
  "palace_delete",
  "kg_add",
  "kg_invalidate",
  "diary_write",
]);

const MEMORY_KV_SCHEMAS: ToolFunctionSchema[] = [
  {
    type: "function",
    function: {
      name: "memory_save",
      description: "Save a key-value pair to long-term memory.",
      parameters: {
        type: "object",
        properties: { key: S("Memory key"), value: S("Value to remember") },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_get",
      description: "Retrieve a value from long-term memory by key.",
      parameters: { type: "object", properties: { key: S("Memory key") }, required: ["key"] },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_list",
      description: "List all keys stored in long-term memory.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

function toStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return String(v);
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function registerMemoryTools(tb: Toolbox, mem: UnifiedMemory): void {
  const handlers = mem.as_tool_map() as unknown as Record<string, (args: Record<string, unknown>) => unknown>;
  const schemas = new Map<string, ToolFunctionSchema>();

  for (const raw of mem.as_tool_schemas() as unknown as ToolFunctionSchema[]) {
    if (raw?.type !== "function" || !raw.function?.name) continue;
    const params = raw.function.parameters as { required?: unknown } | undefined;
    if (params && !Array.isArray(params.required)) params.required = [];
    schemas.set(raw.function.name, raw);
  }
  for (const s of MEMORY_KV_SCHEMAS) schemas.set(s.function.name, s);

  for (const name of MEMORY_TOOL_NAMES) {
    const fn = handlers[name];
    const schema = schemas.get(name);
    if (!fn || !schema) continue;
    tb.registerSpec(schema, (args) => toStr(fn(args)), DESTRUCTIVE.has(name) ? { destructive: true } : {});
  }
}
