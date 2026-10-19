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
