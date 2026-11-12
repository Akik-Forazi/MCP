/**
 * Router — provider selection, failure classification, and chat calls for the
 * router/* endpoint family. All calls are plain OpenAI-compatible
 * POST {baseUrl}/chat/completions via global fetch; keys never leave this
 * module except in the Authorization header.
 */

import { apiKeyOf, type GatewayConfig, type ProviderConfig } from "./config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
}

export interface ChatOutcome {
  text: string;
  provider: string;
  model: string;
  ms: number;
}

export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(provider: string, message: string, status: number | null, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}

/** Longest-prefix routing rule wins; falls back to `routing.default`, then all. */
export function pickProviders(config: GatewayConfig, model?: string): ProviderConfig[] {
  const byPrefix = config.routing?.byModelPrefix ?? {};
  let chosen: string | undefined;
  if (model) {
    let bestLen = -1;
    for (const [prefix, providerName] of Object.entries(byPrefix)) {
      if (model.startsWith(prefix) && prefix.length > bestLen) {
        bestLen = prefix.length;
        chosen = providerName;
      }
    }
  }
  chosen ??= config.routing?.default;
  if (chosen) {
    const match = config.providers.filter((p) => p.name === chosen);
    if (match.length > 0) return match;
  }
  return [...config.providers];
}

/** Providers whose explicit `models` list matches the requested model id. */
export function providersForModel(config: GatewayConfig, model: string): ProviderConfig[] {
  return config.providers.filter((p) => (p.models ?? []).some((m) => m === model || model.endsWith(`/${m}`)));
}

export function modelFor(provider: ProviderConfig, requested?: string): string {
  if (requested) return requested;
  const models = provider.models ?? [];
  if (models.length > 0) return models[0] as string;
  return "default";
}

function classify(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export async function chatOnce(
  provider: ProviderConfig,
  request: ChatRequest,
  signal?: AbortSignal,
): Promise<ChatOutcome> {
  const key = apiKeyOf(provider);
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const timeoutMs = provider.timeoutMs ?? 60_000;
  const timer = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, timer]) : timer;
  const started = Date.now();
  const model = modelFor(provider, request.model);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      }),
      signal: composed,
    });
  } catch (err) {
    if (signal?.aborted) throw new ProviderError(provider.name, `aborted`, null, false);
    throw new ProviderError(
      provider.name,
      `network error: ${err instanceof Error ? err.message : String(err)}`,
      null,
      true,
    );
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 400);
    throw new ProviderError(provider.name, `HTTP ${String(response.status)}: ${body}`, response.status, classify(response.status));
  }

  const payload = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
    model?: unknown;
  } | null;
  const choice = payload?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : typeof choice?.text === "string" ? choice.text : "";
  if (!text) {
    throw new ProviderError(provider.name, "empty completion in response", response.status, true);
  }
  return {
    text,
    provider: provider.name,
    model: typeof payload?.model === "string" ? payload.model : model,
    ms: Date.now() - started,
  };
}

export async function askRouted(
  config: GatewayConfig,
  request: ChatRequest,
  opts: { providers?: ProviderConfig[]; signal?: AbortSignal } = {},
): Promise<ChatOutcome> {
  const chain = opts.providers ?? pickProviders(config, request.model);
  if (chain.length === 0) {
    throw new ProviderError("router", "no providers configured (see ~/.fraziym/config.json)", null, false);
  }
  const failures: string[] = [];
  for (const provider of chain) {
    try {
      return await chatOnce(provider, request, opts.signal);
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) throw err;
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new ProviderError("router", `all providers failed: ${failures.join(" | ")}`, null, false);
}

export async function raceModels(
  config: GatewayConfig,
  models: string[],
  request: ChatRequest,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ChatOutcome> {
  const candidates: Array<{ provider: ProviderConfig; model: string }> = [];
  for (const model of models) {
    const pool = providersForModel(config, model);
    if (pool.length > 0) {
      candidates.push({ provider: pool[0] as ProviderConfig, model });
    } else {
      const fallback = pickProviders(config, model)[0];
      if (fallback) candidates.push({ provider: fallback, model });
    }
  }
  if (candidates.length === 0) {
    throw new ProviderError("router", "no providers configured for the requested models", null, false);
  }
  const controller = new AbortController();
  const election = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, election, controller.signal]) : AbortSignal.any([election, controller.signal]);
  try {
    return await Promise.any(
      candidates.map(({ provider, model }) => chatOnce(provider, { ...request, model }, signal)),
    );
  } catch (err) {
    const detail =
      err instanceof AggregateError
        ? err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join(" | ")
        : err instanceof Error
          ? err.message
          : String(err);
    throw new ProviderError("router", `race failed: ${detail}`, null, false);
  } finally {
    controller.abort();
  }
}

// ============================================================================
// Provider Health Tracking
// ============================================================================

interface ProviderHealth {
  name: string;
  successes: number;
  failures: number;
  lastSuccess: number | null;
  lastFailure: number | null;
  lastError: string | null;
  avgLatencyMs: number;
  totalLatencyMs: number;
}

const healthMap = new Map<string, ProviderHealth>();

export function getProviderHealth(name: string): ProviderHealth {
  if (!healthMap.has(name)) {
    healthMap.set(name, {
      name,
      successes: 0,
      failures: 0,
      lastSuccess: null,
      lastFailure: null,
      lastError: null,
      avgLatencyMs: 0,
      totalLatencyMs: 0,
    });
  }
  return healthMap.get(name)!;
}

export function recordSuccess(name: string, latencyMs: number): void {
  const h = getProviderHealth(name);
  h.successes++;
  h.lastSuccess = Date.now();
  h.totalLatencyMs += latencyMs;
  h.avgLatencyMs = Math.round(h.totalLatencyMs / h.successes);
}

export function recordFailure(name: string, error: string): void {
  const h = getProviderHealth(name);
  h.failures++;
  h.lastFailure = Date.now();
  h.lastError = error;
}

export function isHealthy(name: string): boolean {
  const h = getProviderHealth(name);
  if (h.failures === 0) return true;
  // Unhealthy if > 5 consecutive failures in last 5 minutes
  if (h.lastFailure && Date.now() - h.lastFailure < 300_000 && h.failures > 5) return false;
  return true;
}

export function healthSummary(): string {
  const lines: string[] = ["Provider Health:"];
  for (const [name, h] of healthMap) {
    const rate = h.successes + h.failures > 0
      ? Math.round((h.successes / (h.successes + h.failures)) * 100)
      : 100;
    const status = isHealthy(name) ? "healthy" : "UNHEALTHY";
    lines.push(
      `  ${name}: ${status} (success: ${String(h.successes)}, fail: ${String(h.failures)}, rate: ${String(rate)}%, avg: ${String(h.avgLatencyMs)}ms)`,
    );
    if (h.lastError) lines.push(`    last error: ${h.lastError.slice(0, 80)}`);
  }
  if (healthMap.size === 0) lines.push("  (no providers tracked yet)");
  return lines.join("\n");
}

// ============================================================================
// Token Budget Tracking (daily, in-memory)
// ============================================================================

interface TokenBudget {
  provider: string;
  dailyLimit: number;
  used: number;
  resetAt: number; // epoch ms
}

const budgetMap = new Map<string, TokenBudget>();

export function setTokenBudget(provider: string, dailyLimit: number): void {
  const now = Date.now();
  const resetAt = now + (24 * 60 * 60 * 1000) - (now % (24 * 60 * 60 * 1000));
  budgetMap.set(provider, { provider, dailyLimit, used: 0, resetAt });
}

export function trackTokens(provider: string, tokens: number): void {
  const b = budgetMap.get(provider);
  if (!b) return;
  if (Date.now() > b.resetAt) {
    b.used = 0;
    b.resetAt = Date.now() + (24 * 60 * 60 * 1000) - (Date.now() % (24 * 60 * 60 * 1000));
  }
  b.used += tokens;
}

export function hasBudget(provider: string): boolean {
  const b = budgetMap.get(provider);
  if (!b) return true; // no budget set = unlimited
  if (Date.now() > b.resetAt) {
    b.used = 0;
    b.resetAt = Date.now() + (24 * 60 * 60 * 1000) - (Date.now() % (24 * 60 * 60 * 1000));
  }
  return b.used < b.dailyLimit;
}

export function budgetSummary(): string {
  const lines: string[] = ["Token Budgets:"];
  for (const [name, b] of budgetMap) {
    const pct = Math.round((b.used / b.dailyLimit) * 100);
    lines.push(`  ${name}: ${String(b.used)}/${String(b.dailyLimit)} tokens (${String(pct)}%) — resets ${new Date(b.resetAt).toISOString()}`);
  }
  if (budgetMap.size === 0) lines.push("  (no budgets set)");
  return lines.join("\n");
}

// ============================================================================
// Context Minimization
// ============================================================================

/**
 * Compress a chat request's messages to fit within a token budget.
 * Strategy: truncate long system/user messages, keep the last N messages.
 */
export function minimizeContext(
  messages: ChatMessage[],
  maxChars: number = 4000,
): ChatMessage[] {
  if (messages.length === 0) return messages;

  // Keep system message (if first) + last 4 messages
  const system = messages[0]?.role === "system" ? messages[0] : null;
  const rest = system ? messages.slice(1) : [...messages];
  const recent = rest.slice(-4);

  const result: ChatMessage[] = [];
  if (system) {
    const content = system.content.length > maxChars / 2
      ? system.content.slice(0, maxChars / 2) + "\n...[truncated]"
      : system.content;
    result.push({ ...system, content });
  }

  for (const msg of recent) {
    const content = msg.content.length > maxChars / 4
      ? msg.content.slice(0, maxChars / 4) + "\n...[truncated]"
      : msg.content;
    result.push({ ...msg, content });
  }

  return result;
}

// ============================================================================
// Enhanced askRouted with health tracking
// ============================================================================

export async function askRoutedWithHealth(
  config: GatewayConfig,
  request: ChatRequest,
  opts: { providers?: ProviderConfig[]; signal?: AbortSignal } = {},
): Promise<ChatOutcome> {
  const chain = (opts.providers ?? pickProviders(config, request.model)).filter((p) => isHealthy(p.name));
  if (chain.length === 0) {
    // All unhealthy — try anyway
    const all = opts.providers ?? pickProviders(config, request.model);
    if (all.length === 0) {
      throw new ProviderError("router", "no providers configured (see ~/.fraziym/config.json)", null, false);
    }
    chain.push(...all);
  }

  // Filter by budget
  const budgeted = chain.filter((p) => hasBudget(p.name));
  const finalChain = budgeted.length > 0 ? budgeted : chain;

  const failures: string[] = [];
  for (const provider of finalChain) {
    if (!hasBudget(provider.name)) continue;
    const started = Date.now();
    try {
      const outcome = await chatOnce(provider, request, opts.signal);
      recordSuccess(provider.name, outcome.ms);
      trackTokens(provider.name, estimateTokens(request.messages, outcome.text));
      return outcome;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      recordFailure(provider.name, msg);
      if (err instanceof ProviderError && !err.retryable) throw err;
      failures.push(msg);
    }
  }
  throw new ProviderError("router", `all providers failed: ${failures.join(" | ")}`, null, false);
}

function estimateTokens(messages: ChatMessage[], response: string): number {
  // Rough estimate: 4 chars per token
  let chars = response.length;
  for (const m of messages) chars += m.content.length;
  return Math.ceil(chars / 4);
}

// ============================================================================
// Model Name Validation
// ============================================================================

export interface ModelInfo {
  id: string;
  available: boolean;
  provider: string;
}

export async function validateModels(config: GatewayConfig): Promise<ModelInfo[]> {
  const results: ModelInfo[] = [];
  for (const provider of config.providers) {
    const key = apiKeyOf(provider);
    const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
    try {
      const response = await fetch(url, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        for (const m of provider.models ?? []) {
          results.push({ id: m, available: false, provider: provider.name });
        }
        continue;
      }
      const payload = (await response.json()) as { data?: Array<{ id?: string }> };
      const availableIds = new Set((payload?.data ?? []).map((m) => m.id ?? ""));
      for (const m of provider.models ?? []) {
        results.push({ id: m, available: availableIds.has(m), provider: provider.name });
      }
    } catch {
      for (const m of provider.models ?? []) {
        results.push({ id: m, available: false, provider: provider.name });
      }
    }
  }
  return results;
}
