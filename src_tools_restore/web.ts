/**
 * Web tool wrappers — binds axoniz `WebTools` (keyless DuckDuckGo search +
 * HTML→text fetch) to web_search / web_get tools.
 */

import type { WebTools } from "@fraziym/axoniz/tools";

import { argInt, argStr } from "../core/args.ts";
import type { Toolbox } from "../core/toolbox.ts";

const S = (description: string) => ({ type: "string", description });
const I = (description: string) => ({ type: "integer", description });

export function registerWebTools(tb: Toolbox, wt: WebTools): void {
  tb.register(
    "web_search",
    "Search the web via DuckDuckGo. Returns titles, URLs and snippets.",
    { query: S("Search query — paste the exact error message for best results"), max_results: I("Max results (default 5)") },
    ["query"],
    (args) => wt.search(argStr(args, "query"), argInt(args, "max_results", 5)),
    { network: true, readOnly: true },
  );

  tb.register(
    "web_get",
    "Fetch a URL and return its readable text content (HTML stripped).",
    { url: S("URL to fetch"), max_chars: I("Max characters to return (default 8000)") },
    ["url"],
    (args) => wt.get(argStr(args, "url"), argInt(args, "max_chars", 8000)),
    { network: true, readOnly: true },
  );
}
