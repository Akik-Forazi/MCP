/**
 * `fraziym-mcp install <client>` — print or merge MCP client configuration,
 * pointing the client at the shipped launcher exe (or `fraziym-mcp` on PATH).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type InstallClient = "claude" | "cursor";

function launcherPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const exe = path.resolve(here, "..", "..", "bin", "fraziym-mcp.exe");
  return fs.existsSync(exe) ? exe : "fraziym-mcp";
}

function configPath(client: InstallClient): string {
  if (client === "claude") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

export function installClient(client: InstallClient, write: boolean): void {
  const command = launcherPath();
  const entry = { command, args: ["serve"] };
  const snippet = JSON.stringify({ mcpServers: { fraziym: entry } }, null, 2);

  process.stdout.write(`# ${client} MCP server config\n${snippet}\n`);
  if (client === "claude") {
    process.stdout.write(`# or: claude mcp add fraziym -- "${command}" serve\n`);
  }

  if (!write) {
    process.stdout.write(`# add --write to merge this into ${configPath(client)}\n`);
    return;
  }

  const file = configPath(client);
  let data: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  const servers = (
    data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {}
  ) as Record<string, unknown>;
  servers.fraziym = entry;
  data.mcpServers = servers;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  process.stdout.write(`# wrote ${file}\n`);
}
