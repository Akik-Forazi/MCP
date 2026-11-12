/**
 * Gateway config — provider pools and verify commands for the router/* and
 * fix/* endpoints, read from the SHARED Fraziym ecosystem config:
 *
 *   ~/.fraziym/config.json          (override: $FRAZIYM_HOME)
 *
 * The file may carry our keys at the top level or under an "mcp" section
 * (`{ "mcp": { "providers": [...], "verify": [...] } }`) so other Fraziym
 * products can share the same file. API keys resolve from inline `apiKey` or,
 * the saner default, the env var named by `apiKeyEnv`; keys are never logged,
 * echoed, or serialized into tool output. Per-product state (audit log, fix
 * queue) lives under $FRAZIYM_MCP_HOME (default: the machine-local FRAZIYM
 * cache, `%LOCALAPPDATA%\FRAZIYM\mcp`), not here.
 */

import fs from "node:fs";
import path from "node:path";

import { fraziymHome, mcpHome } from "../core/home.ts";

export { fraziymHome, mcpHome };

export interface ProviderConfig {
  name: string;
  kind: "openai";
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  models?: string[];
  /** Per-request timeout; default 60000. */
  timeoutMs?: number;
}

export interface VerifyCommand {
  name: string;
  cmd: string;
  args?: string[];
}

export interface GatewayConfig {
  providers: ProviderConfig[];
  routing?: {
    /** Provider name used when no model matches a prefix rule. */
    default?: string;
    /** Longest-prefix match on the requested model id → provider name. */
    byModelPrefix?: Record<string, string>;
  };
  verify?: VerifyCommand[];
}

/** Shared Fraziym config dir (~/.fraziym, or $FRAZIYM_HOME). */
export function configPath(home = fraziymHome()): string {
  return path.join(home, "config.json");
}

export interface LoadedConfig {
  config: GatewayConfig;
  path: string;
  exists: boolean;
  error?: string;
}

/** Accept our keys at the top level or under an "mcp" section (shared file). */
function scope(raw: Partial<GatewayConfig>): Partial<GatewayConfig> {
  const nested = (raw as { mcp?: Partial<GatewayConfig> }).mcp;
  if (
    nested &&
    typeof nested === "object" &&
    (nested.providers !== undefined || nested.verify !== undefined || nested.routing !== undefined)
  ) {
    return nested;
  }
  return raw;
}

/** Load axoniz LLM providers and merge them into gateway providers. */
export function loadAxonizProviders(): ProviderConfig[] {
  const axonizHome = process.env.FRAZIYM_HOME
    ? path.join(process.env.FRAZIYM_HOME, "axoniz")
    : path.join(process.env.HOME || process.env.USERPROFILE || "", ".fraziym", "axoniz");
  const file = path.join(axonizHome, "config.json");
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const providers = raw?.llm?.providers ?? raw?.providers ?? {};
    const result: ProviderConfig[] = [];
    for (const [name, cfg] of Object.entries(providers)) {
      const c = cfg as Record<string, unknown>;
      if (c.enabled === false) continue;
      result.push({
        name,
        kind: "openai",
        baseUrl: String(c.baseUrl ?? c.base_url ?? "https://openrouter.ai/api/v1"),
        apiKey: c.apiKey ? String(c.apiKey) : (c.api_key ? String(c.api_key) : undefined),
        apiKeyEnv: c.apiKeyEnv ? String(c.apiKeyEnv) : (c.api_key_env ? String(c.api_key_env) : undefined),
        models: c.model ? [String(c.model)] : (Array.isArray(c.models) ? c.models.map(String) : undefined),
        timeoutMs: typeof c.timeoutMs === "number" ? c.timeoutMs : undefined,
      });
    }
    return result;
  } catch {
    return [];
  }
}

export function loadGatewayConfig(home = fraziymHome()): LoadedConfig {
  const file = configPath(home);
  const axonizProviders = loadAxonizProviders();
  if (!fs.existsSync(file)) {
    if (axonizProviders.length > 0) {
      return { config: { providers: axonizProviders }, path: file, exists: false };
    }
    return { config: { providers: [] }, path: file, exists: false };
  }
  try {
    const raws = scope(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<GatewayConfig>);
    const providers = Array.isArray(raws.providers)
      ? raws.providers.filter(
          (p): p is ProviderConfig =>
            typeof p === "object" &&
            p !== null &&
            typeof (p as ProviderConfig).name === "string" &&
            typeof (p as ProviderConfig).baseUrl === "string",
        )
      : [];
    // Merge axoniz providers (dedup by name)
    const axonizProviders = loadAxonizProviders();
    const existingNames = new Set(providers.map((p) => p.name));
    for (const ap of axonizProviders) {
      if (!existingNames.has(ap.name)) {
        providers.push(ap);
        existingNames.add(ap.name);
      }
    }
    return {
      config: {
        providers,
        ...(raws.routing ? { routing: raws.routing } : {}),
        ...(Array.isArray(raws.verify) ? { verify: raws.verify } : {}),
      },
      path: file,
      exists: true,
    };
  } catch (err) {
    return {
      config: { providers: [] },
      path: file,
      exists: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function apiKeyOf(provider: ProviderConfig): string | null {
  if (provider.apiKey && provider.apiKey.trim()) return provider.apiKey.trim();
  if (provider.apiKeyEnv && provider.apiKeyEnv.trim()) {
    const value = process.env[provider.apiKeyEnv.trim()];
    if (value && value.trim()) return value.trim();
  }
  return null;
}
