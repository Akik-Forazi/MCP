/**
 * AXONIZ WebTools — web access (TypeScript port).
 *
 * Ported from `axoniz/tools/web_tools.py`. Keeps the DuckDuckGo HTML-scrape
 * search (no external API keys) and the HTML→text sanitisation pipeline.
 *
 * Python-stdlib mapping:
 *   urllib.request.urlopen(req, timeout=15) -> global fetch + AbortSignal.timeout
 *   re.sub(re.DOTALL)                       -> RegExp with the `s` flag
 */

export class WebTools {
  /**
   * NOTE: the Python original also carried `self.workspace`. It was never read
   * in `web_tools.py`, so it is accepted for constructor-signature parity but
   * intentionally unused.
   */
  readonly workspace: string;

  // Standard identification header for reliable communication with servers.
  readonly HEADERS: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (AXONIZ-ZERO Intelligence Agent/1.0)",
  };

  constructor(workspace = ".") {
    this.workspace = workspace;
  }

  /**
   * Retrieve the textual content of a URL, stripping HTML boilerplate and
   * focusing on readable text.
   */
  async get(url: string, maxChars = 8000): Promise<string> {
    try {
      const resp = await fetch(url, {
        headers: this.HEADERS,
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const raw = await readBodyText(resp);

      // High-efficiency sanitization: removal of non-content elements.
      let text = raw.replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
      text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");
      text = text.replace(/<[^>]+>/g, " ");
      text = text.replace(/\s+/g, " ").trim();

      // Enforcing a safe buffer limit to prevent context overflow.
      if (text.length > maxChars) {
        text = `${text.slice(0, maxChars)}\n... (Content truncated for brevity, ${text.length} total characters)`;
      }

      return `Retrieved Content from ${url}:\n${text}`;
    } catch (e) {
      return `Error: Unable to access ${url}. ${errorText(e)}`;
    }
  }

  /**
   * Web search via DuckDuckGo's lightweight HTML interface.
   * Returns a structured summary of titles, URLs and snippets.
   */
  async search(query: string, maxResults = 5): Promise<string> {
    try {
      // Preparing the search query for the URL (urllib.parse.quote_plus).
      const encoded = encodeURIComponent(query).replace(/%20/g, "+");
      const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
      const resp = await fetch(url, {
        headers: { ...this.HEADERS, "Accept-Language": "en-US" },
        signal: AbortSignal.timeout(15_000),
        redirect: "follow",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const raw = await readBodyText(resp);

      // Parsing the search result blocks from the raw response.
      const results: string[] = [];
      const blocks = raw.match(/class="result__body"[\s\S]*?(?=class="result__body"|$)/g) ?? [];

      for (const block of blocks.slice(0, maxResults)) {
        const titleM = /class="result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        const urlM = /href="(https?:\/\/[^"]+)"/.exec(block);
        const snippetM = /class="result__snippet"[^>]*>([\s\S]*?)<\/span>/.exec(block);

        const title = titleM ? stripTags(titleM[1]!).trim() : "Untitled Result";
        const resultUrl = urlM ? urlM[1]! : "No link available";
        const snippet = snippetM ? stripTags(snippetM[1]!).trim() : "No summary available.";

        results.push(
          `  [${results.length + 1}] ${title}\n      Source: ${resultUrl}\n      Summary: ${snippet}`,
        );
      }

      if (results.length === 0) {
        return `Intelligence Report: No relevant information found for '${query}'.`;
      }

      return `Web Search Results for '${query}':\n${results.join("\n\n")}`;
    } catch (e) {
      return `Error: Search operation failed. ${errorText(e)}`;
    }
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

/** Python's `str(e)` rendering for an unknown thrown value. */
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Read a response body as UTF-8 with undecodable bytes replaced, with a cap. */
async function readBodyText(resp: Response): Promise<string> {
  const buf = Buffer.from(await resp.arrayBuffer());
  const capped = buf.length > WebTools_MAX_BODY ? buf.subarray(0, WebTools_MAX_BODY) : buf;
  return capped.toString("utf8");
}

const WebTools_MAX_BODY = 20 * 1024 * 1024;
