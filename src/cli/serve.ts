/**
 * `fraziym-mcp serve` — MCP server over stdio (newline-delimited JSON-RPC 2.0).
 *
 * stdout carries protocol only; axoniz's logger already writes to stderr, so
 * INFO banners cannot corrupt the stream. Implements initialize / ping /
 * tools/list / tools/call; unknown methods get JSON-RPC -32601.
 */

import readline from "node:readline";

import type { Toolbox } from "../core/toolbox.ts";
import { pkgVersion, toolboxFor, type ToolGroup } from "./util.ts";

export interface ServeOptions {
  workspace: string;
  group: ToolGroup;
  readOnly: boolean;
  noNetwork: boolean;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

export async function serve(opts: ServeOptions): Promise<void> {
  let tb: Toolbox = toolboxFor(opts.group, opts.workspace);
  if (opts.readOnly) tb = tb.subset((_spec, meta) => meta.destructive !== true);
  if (opts.noNetwork) tb = tb.subset((_spec, meta) => meta.network !== true);

  const version = pkgVersion();
  const send = (msg: unknown): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed) as RpcRequest;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    const { id, method } = req;
    const params = req.params ?? {};
    const isNotification = id === undefined || id === null;

    try {
      switch (method) {
        case "initialize":
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion:
                typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "fraziym-mcp", version },
            },
          });
          break;

        case "notifications/initialized":
        case "notifications/cancelled":
          break;

        case "ping":
          if (!isNotification) send({ jsonrpc: "2.0", id, result: {} });
          break;

        case "tools/list":
          send({
            jsonrpc: "2.0",
            id,
            result: {
              tools: tb.specs().map((s) => ({
                name: s.function.name,
                description: s.function.description,
                inputSchema: s.function.parameters,
              })),
            },
          });
          break;

        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const args =
            params.arguments && typeof params.arguments === "object"
              ? (params.arguments as Record<string, unknown>)
              : {};
          const text = await tb.call(name, args);
          send({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text }], isError: text.startsWith("[ERROR]") },
          });
          break;
        }

        default:
          if (!isNotification) {
            send({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Method not found: ${String(method)}` },
            });
          }
      }
    } catch (e) {
      if (!isNotification) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
        });
      }
    }
  };

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    void handleLine(line);
  });

  process.stderr.write(
    `[fraziym-mcp] serving ${String(tb.names().length)} tools (group: ${opts.group}) over stdio\n`,
  );

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}
