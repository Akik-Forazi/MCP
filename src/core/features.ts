/**
 * Server features — resources, prompts and completion for the default server.
 *
 * Real product surface (no fixtures):
 *   - `fraziym://catalog`        the generated tool catalog as JSON
 *   - `fraziym://audit/recent`   tail of the redacted audit log as JSON
 *   - `fraziym://workspace/{path}` text/binary reads inside the workspace jail
 *   - `review_changes` / `orient_repo` / `debug_failure` / `find_tool` prompts
 *   - completion for the workspace template (path prefixes)
 *
 * Everything is workspace-jailed with the same `resolveWithin` the guard uses;
 * reads are truncated like tool output.
 */

import fs from "node:fs";
import path from "node:path";

import { loadCatalog } from "./catalog.ts";
import { resolveWithin, truncateOutput } from "./guard.ts";
import type { McpContentBlock } from "./types.ts";

export interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType?: string;
}

export interface ResourceTemplateDef {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType?: string;
}

export interface ResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface PromptArgumentDef {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  description: string;
  arguments?: PromptArgumentDef[];
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: McpContentBlock;
}

export interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

export interface CompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

export class ResourceNotFoundError extends Error {
  constructor(uri: string) {
    super(`Resource not found: ${uri}`);
    this.name = "ResourceNotFoundError";
  }
}

export class PromptNotFoundError extends Error {
  constructor(name: string) {
    super(`Prompt not found: ${name}`);
    this.name = "PromptNotFoundError";
  }
}

export class PromptArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptArgumentError";
  }
}

export const CATALOG_URI = "fraziym://catalog";
export const AUDIT_URI = "fraziym://audit/recent";
export const WORKSPACE_TEMPLATE = "fraziym://workspace/{path}";
const WORKSPACE_PREFIX = "fraziym://workspace/";

const MAX_RESOURCE_BYTES = 65536;

function isBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(8192, buf.length));
  return head.includes(0);
}

function textBlock(role: "user" | "assistant", text: string): PromptMessage {
  return { role, content: { type: "text", text } };
}

export interface ServerFeaturesOptions {
  workspace: string;
  /** Machine-local FRAZIYM mcp home (audit log location). */
  home: string;
}

export class ServerFeatures {
  private readonly workspace: string;
  private readonly home: string;

  constructor(opts: ServerFeaturesOptions) {
    this.workspace = opts.workspace;
    this.home = opts.home;
  }

  listResources(): ResourceDef[] {
    return [
      {
        uri: CATALOG_URI,
        name: "Tool catalog",
        description: "Every tool this server exposes, with schemas and capability metadata (JSON).",
        mimeType: "application/json",
      },
      {
        uri: AUDIT_URI,
        name: "Recent audit records",
        description: "Tail of the redacted per-call audit log for this machine (JSON lines).",
        mimeType: "application/json",
      },
    ];
  }

  listResourceTemplates(): ResourceTemplateDef[] {
    return [
      {
        uriTemplate: WORKSPACE_TEMPLATE,
        name: "Workspace file",
        description: "Any file inside the workspace root, read through the same jailed resolver the tools use.",
        mimeType: "text/plain",
      },
    ];
  }

  readResource(uri: string, opts: { allowOutside?: boolean } = {}): ResourceContents {
    if (uri === CATALOG_URI) {
      const catalog = loadCatalog();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(catalog ?? { version: "unknown", tools: [] }, null, 2),
      };
    }
    if (uri === AUDIT_URI) {
      let lines: string[] = [];
      try {
        const raw = fs.readFileSync(path.join(this.home, "audit.jsonl"), "utf8");
        lines = raw.split(/\r?\n/).filter(Boolean).slice(-100);
      } catch {
        lines = [];
      }
      return { uri, mimeType: "application/json", text: `[${lines.join(",")}]` };
    }
    if (uri.startsWith(WORKSPACE_PREFIX)) {
      const rel = decodeURIComponent(uri.slice(WORKSPACE_PREFIX.length));
      const full = resolveWorkspacePath(this.workspace, rel, opts.allowOutside ?? false);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        throw new ResourceNotFoundError(uri);
      }
      if (!stat.isFile()) throw new ResourceNotFoundError(uri);
      const buf = fs.readFileSync(full);
      if (isBinary(buf)) {
        return { uri, mimeType: "application/octet-stream", blob: buf.toString("base64") };
      }
      const { text } = truncateOutput(buf.toString("utf8"), MAX_RESOURCE_BYTES);
      return { uri, mimeType: "text/plain", text };
    }
    throw new ResourceNotFoundError(uri);
  }

  listPrompts(): PromptDef[] {
    return [
      {
        name: "review_changes",
        description: "Review the uncommitted changes in this workspace: call git_status + git_diff, then critique correctness, security and style.",
      },
      {
        name: "orient_repo",
        description: "Orient in this repository: map the layout, find the entry points, and suggest where a task would touch.",
      },
      {
        name: "debug_failure",
        description: "Structured debugging of a failing command: reproduce, isolate, propose a minimal fix.",
        arguments: [
          { name: "command", description: "The command that failed", required: true },
          { name: "output", description: "The captured error output", required: true },
        ],
      },
      {
        name: "find_tool",
        description: "Find the right tool for a task by querying tools_discover, then explain how to call it.",
        arguments: [{ name: "task", description: "What you are trying to do", required: true }],
      },
    ];
  }

  getPrompt(name: string, args: Record<string, string>): GetPromptResult {
    const require = (key: string): string => {
      const v = args[key];
      if (typeof v !== "string" || v.length === 0) {
        throw new PromptArgumentError(`missing required prompt argument "${key}"`);
      }
      return v;
    };

    switch (name) {
      case "review_changes":
        return {
          description: "Review the workspace diff",
          messages: [
            textBlock(
              "user",
              "Review the current uncommitted changes in this workspace.\n\n" +
                "1. Call `git_status` and `git_diff` (add `--staged` if needed).\n" +
                "2. Summarize what changed and why it might have changed.\n" +
                "3. Flag correctness bugs, security issues, and style mismatches with file:line references.\n" +
                "4. End with the smallest set of follow-up actions.",
            ),
          ],
        };
      case "orient_repo":
        return {
          description: "Orient in the workspace",
          messages: [
            textBlock(
              "user",
              "Orient in this repository before starting work.\n\n" +
                "1. List the top-level layout (`file_list`).\n" +
                "2. Find entry points and package manifests; read the README if present.\n" +
                "3. If axodex is indexed, run `axodex_search` for the main concepts.\n" +
                "4. Produce a short map: modules, their roles, and where tests live.",
            ),
          ],
        };
      case "debug_failure": {
        const command = require("command");
        const output = require("output");
        return {
          description: "Debug a failing command",
          messages: [
            textBlock(
              "user",
              "A command failed in this workspace. Debug it systematically.\n\n" +
                `Command:\n\`\`\`\n${command}\n\`\`\`\n\n` +
                `Output:\n\`\`\`\n${output}\n\`\`\`\n\n` +
                "1. Reproduce with the same command (`shell_run`).\n" +
                "2. Isolate the failing unit and read the relevant files.\n" +
                "3. State the root cause with evidence, then propose the minimal fix.\n" +
                "4. Re-run to verify.",
            ),
          ],
        };
      }
      case "find_tool": {
        const task = require("task");
        return {
          description: "Find the right tool",
          messages: [
            textBlock(
              "user",
              `Find the best tool for this task: "${task}".\n\n` +
                "1. Call `tools_discover` with a short keyword list (requires `serve --router-tools`).\n" +
                "2. If it is not available, scan `fraziym://catalog` or the tools/list output.\n" +
                "3. Explain the chosen tool and give the exact arguments to call it.",
            ),
          ],
        };
      }
      default:
        throw new PromptNotFoundError(name);
    }
  }

  complete(
    ref: { type?: unknown; name?: unknown; uri?: unknown },
    argument: { name?: unknown; value?: unknown },
  ): CompletionResult {
    const argName = typeof argument.name === "string" ? argument.name : "";
    const value = typeof argument.value === "string" ? argument.value : "";

    if (ref.type === "ref/resource" && ref.uri === WORKSPACE_TEMPLATE) {
      return { values: this.completeWorkspacePaths(value), hasMore: false };
    }

    if (ref.type === "ref/prompt") {
      const hints: Record<string, string[]> = {
        "debug_failure:command": ["npm test", "npm run build", "git status", "node --test"],
      };
      const name = typeof ref.name === "string" ? ref.name : "";
      const candidates = hints[`${name}:${argName}`] ?? [];
      return {
        values: candidates.filter((v) => v.startsWith(value)),
        hasMore: false,
      };
    }

    return { values: [], hasMore: false };
  }

  private completeWorkspacePaths(prefix: string): string[] {
    const out: string[] = [];
    const base = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/") + 1) : "";
    let dir = path.resolve(this.workspace, base || ".");
    try {
      if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
    } catch {
      return out;
    }
    const walk = (cur: string, depth: number): void => {
      if (out.length >= 50 || depth > 3) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= 50) return;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const rel = path.relative(this.workspace, path.join(cur, entry.name)).split(path.sep).join("/");
        if (!rel.startsWith(prefix)) continue;
        if (entry.isDirectory()) {
          out.push(`${rel}/`);
          walk(path.join(cur, entry.name), depth + 1);
        } else {
          out.push(rel);
        }
      }
    };
    walk(dir, 0);
    return out.slice(0, 50);
  }
}

/** Jailed resolver for workspace resource reads (same rules as the guard). */
function resolveWorkspacePath(root: string, p: string, allowOutside: boolean): string {
  return resolveWithin(root, p, allowOutside);
}
