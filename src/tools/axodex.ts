/**
 * Axodex tool wrappers — binds axoniz `AxodexTools` (graph-powered code
 * intelligence via the axodex CLI) to axodex_* tools.
 */

import type { AxodexTools } from "@fraziym/axoniz/tools";

import { argInt, argStr } from "../core/args.ts";
import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

export function registerAxodexTools(tb: Toolbox, at: AxodexTools): void {
  tb.register(
    "axodex_query",
    "Semantic search across the codebase knowledge graph (concepts, flows).",
    { query: S("Concept or question to search for"), limit: I("Max hits (default 10)") },
    ["query"],
    (args) => at.query(argStr(args, "query"), argInt(args, "limit", 10)),
  );

  tb.register(
    "axodex_context",
    "Get architectural context for a named symbol (callers, callees, process).",
    { name: S("Symbol name") },
    ["name"],
    (args) => at.context(argStr(args, "name")),
  );

  tb.register(
    "axodex_impact",
    "Blast-radius analysis: what breaks if this symbol changes.",
    { target: S("Symbol to analyze"), direction: S('"upstream" (default) or "downstream"') },
    ["target"],
    (args) => at.impact(argStr(args, "target"), argStr(args, "direction", "upstream")),
  );

  tb.register(
    "axodex_smart_read",
    "Read a symbol with its graph context instead of raw file text.",
    { symbol: S("Symbol name") },
    ["symbol"],
    (args) => at.smart_read(argStr(args, "symbol")),
  );

  tb.register(
    "axodex_status",
    "Index freshness / stats for the workspace's code graph.",
    {},
    [],
    () => at.status(),
  );
}
