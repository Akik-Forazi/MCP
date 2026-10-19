/**
 * `fraziym-mcp serve` — MCP server over stdio (default) or Streamable HTTP.
 *
 * Transport shell only: all protocol logic (dual-era negotiation, tools/list,
 * tools/call, cancellation, logging, server/discover) lives in CoreServer.
 * stdout carries protocol only; diagnostics go to stderr.
 */

import readline from "node:readline";

import type { ToolGroup } from "../core/catalog.ts";
import { LazyToolHost } from "../core/host.ts";
import { mcpHome } from "../core/home.ts";
import { GatewayHost } from "../gateway/host.ts";
import type { ToolHostLike } from "../protocol/server.ts";
import { CoreServer } from "../protocol/server.ts";
import { serveHttp } from "../protocol/http.ts";
import { pkgVersion } from "./version.ts";

export interface ServeOptions {
  workspace: string;
  group: ToolGroup;
  readOnly: boolean;
  noNetwork: boolean;
  allowOutside?: boolean;
  audit?: boolean;
  /** Streamable HTTP instead of stdio. */
  http?: boolean;
  port?: number;
  host?: string;
  token?: string;
  /** tools/call burst capacity per client over HTTP; 0 disables. Default 30. */
  rateLimitBurst?: number;
  /** Advertise the gateway endpoints (router_*, fix_*, brain_*, …) too. */
  routerTools?: boolean;
}

export async function serve(opts: ServeOptions): Promise<void> {
  const lazy = new LazyToolHost({
    workspace: opts.workspace,
    group: opts.group,
    readOnly: opts.readOnly,
    noNetwork: opts.noNetwork,
    guard: { audit: opts.audit ?? true, ...(opts.allowOutside ? { allowOutside: true } : {}) },
  });

  const host: ToolHostLike = opts.routerTools
    ? new GatewayHost(lazy, {
        home: mcpHome(),
        guard: { audit: opts.audit ?? true, ...(opts.allowOutside ? { allowOutside: true } : {}) },
      })
    : lazy;

  const server = new CoreServer({
    host,
    version: pkgVersion(),
    log: (line) => process.stderr.write(`${line}\n`),
  });

  const toolCount = host.names().length;

  if (opts.http) {
    const rateLimitBurst = opts.rateLimitBurst ?? 30;
    const handle = await serveHttp({
      server,
      port: opts.port ?? 7777,
      host: opts.host ?? "127.0.0.1",
      token: opts.token,
      rateLimit: rateLimitBurst > 0 ? { burst: rateLimitBurst, perSecond: Math.max(1, rateLimitBurst / 2) } : false,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.stderr.write(
      `[fraziym-mcp] serving ${String(toolCount)} tools (group: ${opts.group}) over Streamable HTTP ` +
        `at ${handle.url} (protocol 2026-07-28 + legacy; sessions: none)\n`,
    );
    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        handle.close().then(
          () => resolve(),
          () => resolve(),
        );
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      process.once("SIGBREAK", shutdown);
    });
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void server.handleLine(trimmed).then((response) => {
      if (response !== null) process.stdout.write(`${response}\n`);
    });
  });

  process.stderr.write(
    `[fraziym-mcp] serving ${String(toolCount)} tools (group: ${opts.group}) over stdio (lazy catalog)\n`,
  );

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
  });
}
