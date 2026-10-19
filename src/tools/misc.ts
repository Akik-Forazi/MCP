/**
 * Misc tools — protocol + standalone helpers from the axoniz 72:
 * get_time, done, absolute_query (combined code-graph + palace search).
 */

import type { UnifiedMemory } from "@fraziym/axoniz/memory";

import { argStr } from "../core/args.ts";
import type { Toolbox } from "../core/toolbox.ts";
import type { AxodexRunner } from "./axodex.ts";

const S = (description: string) => ({ type: "string", description });

export interface MiscToolDeps {
  axodex: AxodexRunner;
  mem: UnifiedMemory;
}

function timeNow(query: string): string {
  const now = new Date();
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const q = query.toLowerCase();
  if (q === "time") return now.toLocaleTimeString();
  if (q === "date") return now.toLocaleDateString();
  if (q === "day") return days[now.getDay()] ?? "";
  if (q === "year") return String(now.getFullYear());
  return `${days[now.getDay()] ?? ""}, ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
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

/** get_time + done — zero dependencies, safe to build without any axoniz class. */
export function registerProtocolTools(tb: Toolbox): void {
  tb.register(
    "get_time",
    "Get the current date and/or time (useful for \"today\", deadlines, scheduling).",
    { query: S('One of "time", "date", "day", "year", or "all" (default)') },
    [],
    (args) => timeNow(argStr(args, "query", "all")),
    { readOnly: true },
  );

  tb.register(
    "done",
    "Call when the task is fully complete; provide a summary of what was accomplished.",
    { result: S("Full summary of everything accomplished") },
    ["result"],
    (args) => {
      const r = argStr(args, "result");
      return r ? `[done] ${r}` : "[done] (no summary provided)";
    },
    { readOnly: true },
  );
}

export function registerMiscTools(tb: Toolbox, deps: MiscToolDeps): void {
  const handlers = deps.mem.as_tool_map() as unknown as Record<
    string,
    (args: Record<string, unknown>) => unknown
  >;
  const palaceSearch = handlers["palace_search"];

  registerProtocolTools(tb);

  tb.register(
    "absolute_query",
    "Absolute query: searches BOTH the codebase (via axodex) AND long-term memory (via palace), returning combined results.",
    { query: S("Concept, symbol, or question to search for") },
    ["query"],
    async (args) => {
      const q = argStr(args, "query");
      const [codeText, memText] = await Promise.all([
        deps.axodex.query(q),
        Promise.resolve(palaceSearch ? palaceSearch({ query: q }) : ""),
      ]);
      return `══ Axodex (code graph) ══\n${toStr(codeText)}\n\n══ Palace (long-term memory) ══\n${toStr(memText)}`;
    },
    { readOnly: true },
  );
}
