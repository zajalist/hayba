/**
 * copilot_* MCP tools (Task 5) — config/introspection for the BYOK in-editor
 * copilot, so an agent (or the C++ panel via `hayba_invoke`) can manage the
 * copilot without guessing at HTTP routes or memorized provider ids.
 *
 * These tools read/write the SAME in-memory config store that
 * `POST/GET /chat/config` (src/chat/chat-server.ts) uses — see the narrow
 * accessors exported there (`getConfigEntry`/`setConfigEntry`/`clearConfigKey`/
 * `maskKey`). No duplicated state.
 *
 * TODO(Task 6): `copilot_key_set` / `copilot_key_clear` currently write/clear
 * the in-memory configStore. Task 6 swaps the storage target to the C++ DPAPI
 * vault (via a localhost handshake) — the tool names, schemas, and the
 * never-echo-the-key contract do not change when that lands.
 *
 * Key-safety invariant (tested — see copilot-tools.test.ts "canary" case): no
 * handler in this file ever places a raw API key value into a ToolResult. Only
 * `last4` (via `maskKey`) is ever returned.
 */

import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import type { ToolHandler, ToolResult } from '../types.js';
import { listProviders, getProvider, type ProviderEntry } from '../../agents/providers.js';
import { createLLMClient, type LLMClient, type LLMClientConfig } from '../../agents/llm-client.js';
import {
  getConfigEntry,
  setConfigEntry,
  clearConfigKey,
  maskKey,
  isChatRoutesRegistered,
} from '../../chat/chat-server.js';
import { listRecordedCommands } from '../schema-registry.js';
import { executeCommand } from '../tool-executor.js';

const PACK = 'copilot';

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function sessionIdOf(args: Record<string, unknown>): string | undefined {
  return typeof args.session_id === 'string' ? args.session_id : undefined;
}

// ---------------------------------------------------------------------------
// Test seam — DI for the LLM client factory used by copilot_provider_test, so
// the probe never touches a real network in tests.
// ---------------------------------------------------------------------------

type ClientFactory = (config: LLMClientConfig) => LLMClient;
let clientFactory: ClientFactory = createLLMClient;

/** Test hook: inject a fake client factory (e.g. one that fails auth deterministically). */
export function __setClientFactory(factory: ClientFactory): void {
  clientFactory = factory;
}

/** Test hook: restore the real factory. */
export function __resetClientFactory(): void {
  clientFactory = createLLMClient;
}

// ---------------------------------------------------------------------------
// copilot_provider_list
// ---------------------------------------------------------------------------

export const providerListMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'checking which BYOK providers are known and which one is active, before configuring the copilot',
  not_when: 'you already know the active provider and just need its model — use copilot_model_list',
  pack: PACK,
};

export const providerListHandler: ToolHandler = async (args) => {
  const sessionId = sessionIdOf(args);
  const cfg = getConfigEntry(sessionId);
  const providers = listProviders().map((p: ProviderEntry) => {
    const isActive = cfg?.provider === p.id;
    return {
      id: p.id,
      label: p.label,
      protocol: p.protocol,
      needs_key: p.needsKey,
      key_hint: p.keyHint,
      default_model: p.defaultModel || null,
      base_url_default: p.baseURLDefault || null,
      active: isActive,
      key_configured: isActive ? Boolean(cfg?.apiKey) : false,
      key_last4: isActive ? maskKey(cfg?.apiKey) : null,
    };
  });
  return ok({ providers, active_provider: cfg?.provider ?? null });
};

// ---------------------------------------------------------------------------
// copilot_provider_set
// ---------------------------------------------------------------------------

export const providerSetMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['mutates in-memory copilot config'],
  when: 'switching the active BYOK provider/model/base URL for a copilot session',
  not_when: 'you only need to change the API key — use copilot_key_set',
  pack: PACK,
};

export const providerSetHandler: ToolHandler = async (args) => {
  const provider = args.provider;
  if (typeof provider !== 'string' || !provider) {
    return fail('provider is required');
  }
  const entry = getProvider(provider);
  if (!entry) {
    return fail(`unknown provider: ${provider}`);
  }
  const sessionId = sessionIdOf(args);
  const existing = getConfigEntry(sessionId);
  const model = typeof args.model === 'string' ? args.model : undefined;
  const baseURL = typeof args.base_url === 'string' ? args.base_url : undefined;
  // Switching provider drops a stale key from a DIFFERENT provider (mirrors the
  // /chat/config route's M2 rule): the key belongs to whichever provider was
  // configured when it was set, not to the new one.
  const keepKey = existing?.provider === provider ? existing?.apiKey : undefined;
  setConfigEntry(sessionId, {
    provider,
    model,
    baseURL,
    apiKey: keepKey,
  });
  return ok({
    ok: true,
    provider,
    model: model ?? entry.defaultModel ?? null,
    base_url: baseURL ?? entry.baseURLDefault ?? null,
    key_last4: maskKey(keepKey),
  });
};

// ---------------------------------------------------------------------------
// copilot_provider_test — needsKey preflight, then a minimal complete() probe.
// ---------------------------------------------------------------------------

export const providerTestMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['may perform one network call to the configured LLM provider'],
  when: 'verifying a BYOK provider/key actually works before relying on it in a chat session',
  not_when: 'just listing catalog/config state — use copilot_provider_list or copilot_key_status (no network)',
  pack: PACK,
};

export const providerTestHandler: ToolHandler = async (args) => {
  const sessionId = sessionIdOf(args);
  const cfg = getConfigEntry(sessionId);
  const provider = typeof args.provider === 'string' && args.provider ? args.provider : cfg?.provider;
  if (!provider) {
    return ok({ ok: false, reason: 'no_provider_configured' });
  }
  const entry = getProvider(provider);
  if (!entry) {
    return ok({ ok: false, reason: 'unknown_provider' });
  }
  const apiKey = provider === cfg?.provider ? cfg?.apiKey : undefined;

  // Preflight: needsKey + no key configured => fail clean, no network call.
  if (entry.needsKey && !apiKey) {
    return ok({ ok: false, reason: 'no_key' });
  }

  const model = typeof args.model === 'string' ? args.model : cfg?.model;
  const start = Date.now();
  try {
    const client = clientFactory({
      provider,
      model,
      baseURL: cfg?.baseURL,
      apiKey,
    });
    await client.complete({
      system: 'You are a connectivity probe. Reply with a single word.',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 8,
    });
    return ok({ ok: true, latency_ms: Date.now() - start, model: client.model });
  } catch (err) {
    const kind = (err as { kind?: string })?.kind;
    const reason = kind === 'auth' ? 'auth_failed' : kind === 'rate_limit' ? 'rate_limited' : kind === 'network' ? 'network_error' : 'api_error';
    return ok({
      ok: false,
      reason,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
};

// ---------------------------------------------------------------------------
// copilot_model_list — advisory, static known-models per provider.
// ---------------------------------------------------------------------------

/**
 * Advisory only: BYOK means the user may point any provider at any model id
 * their key/endpoint supports (esp. `custom` and `openrouter`, whose catalogs
 * rotate). This list is a convenience starting point, NOT a validated set.
 */
const KNOWN_MODELS: Record<string, string[]> = {
  mock: ['mock'],
  anthropic: ['claude-opus-4-8', 'claude-sonnet-4-8', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  openrouter: [], // free-tier slugs rotate — no stable defaults; see providers.ts
  ollama: ['qwen2.5-coder:7b-instruct', 'llama3.1:8b'],
  lmstudio: ['local-model'],
  custom: [],
};

export const modelListMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'picking a model id for a provider before calling copilot_provider_set',
  not_when: 'you already have a model id in hand — this list is advisory, not a validator',
  pack: PACK,
};

export const modelListHandler: ToolHandler = async (args) => {
  const provider = args.provider;
  if (typeof provider !== 'string' || !provider) {
    return fail('provider is required');
  }
  const entry = getProvider(provider);
  if (!entry) {
    return fail(`unknown provider: ${provider}`);
  }
  const sessionId = sessionIdOf(args);
  const cfg = getConfigEntry(sessionId);
  const configuredModel = cfg?.provider === provider ? cfg?.model : undefined;
  const known = KNOWN_MODELS[provider] ?? [];
  const models = new Set(known);
  if (configuredModel) models.add(configuredModel);
  if (entry.defaultModel) models.add(entry.defaultModel);
  return ok({
    provider,
    default_model: entry.defaultModel || null,
    configured_model: configuredModel ?? null,
    known_models: [...models],
    advisory: true,
    note: 'BYOK: any model id your key/endpoint supports may work, even if absent from this list.',
  });
};

// ---------------------------------------------------------------------------
// copilot_key_set / copilot_key_clear
// ---------------------------------------------------------------------------

export const keySetMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['writes an API key into the in-memory copilot config (TODO Task 6: DPAPI vault)'],
  when: 'configuring the BYOK key for a provider before using the copilot',
  not_when: 'switching providers without changing the key — use copilot_provider_set',
  pack: PACK,
};

export const keySetHandler: ToolHandler = async (args) => {
  const provider = args.provider;
  const apiKey = args.api_key;
  if (typeof provider !== 'string' || !provider) {
    return fail('provider is required');
  }
  if (typeof apiKey !== 'string' || !apiKey) {
    return fail('api_key is required');
  }
  if (!getProvider(provider)) {
    return fail(`unknown provider: ${provider}`);
  }
  const sessionId = sessionIdOf(args);
  const existing = getConfigEntry(sessionId);
  setConfigEntry(sessionId, {
    provider,
    model: existing?.provider === provider ? existing?.model : undefined,
    baseURL: existing?.provider === provider ? existing?.baseURL : undefined,
    apiKey,
  });
  // NEVER echo the key — masked last-4 only.
  return ok({ ok: true, provider, key_last4: maskKey(apiKey) });
};

export const keyClearMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['clears the stored API key for a provider (in-memory; TODO Task 6: DPAPI vault)'],
  when: 'removing a stored BYOK key, e.g. before handing off a machine or rotating credentials',
  not_when: 'never — this is destructive and plan-gated when Plan Mode is on',
  pack: PACK,
};

export const keyClearHandler: ToolHandler = async (args) => {
  const provider = args.provider;
  if (typeof provider !== 'string' || !provider) {
    return fail('provider is required');
  }
  const sessionId = sessionIdOf(args);
  const existing = getConfigEntry(sessionId);
  if (existing?.provider !== provider) {
    // Nothing configured for this provider — clearing is a no-op, not an error.
    return ok({ ok: true, provider, cleared: false });
  }
  clearConfigKey(sessionId);
  return ok({ ok: true, provider, cleared: true });
};

// ---------------------------------------------------------------------------
// copilot_key_status
// ---------------------------------------------------------------------------

export const keyStatusMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'checking whether a key is configured for each provider, without a network call',
  not_when: 'verifying the key actually authenticates — use copilot_provider_test',
  pack: PACK,
};

export const keyStatusHandler: ToolHandler = async (args) => {
  const sessionId = sessionIdOf(args);
  const cfg = getConfigEntry(sessionId);
  const providers = listProviders().map((p) => {
    const isActive = cfg?.provider === p.id;
    const configured = isActive && Boolean(cfg?.apiKey);
    return {
      provider: p.id,
      configured,
      last4: configured ? maskKey(cfg?.apiKey) : undefined,
    };
  });
  return ok({ providers });
};

// ---------------------------------------------------------------------------
// copilot_health
// ---------------------------------------------------------------------------

export const healthMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'diagnosing whether the copilot sidecar/UE bridge/tool registry are up before troubleshooting a chat failure',
  not_when: 'you just need provider/key state — use copilot_provider_list / copilot_key_status',
  pack: PACK,
};

export const healthHandler: ToolHandler = async (args) => {
  const sessionId = sessionIdOf(args);
  const cfg = getConfigEntry(sessionId);
  let ueConnected = false;
  try {
    // `editor_get_state` is the WIRE command. This used to send
    // `hayba_check_ue_status`, which is the TypeScript tool's name and
    // something no handler declares -- so the call always threw and
    // `ue_connected` was reported false even with a healthy editor on the
    // other end. A health check that is always unhealthy is worse than none:
    // it sends people to debug a connection that was never broken.
    await executeCommand('editor_get_state', {}, { timeout: 2000 });
    ueConnected = true;
  } catch {
    ueConnected = false;
  }
  return ok({
    sidecar_ok: isChatRoutesRegistered(),
    ue_connected: ueConnected,
    tools_available: listRecordedCommands().length,
    active_provider: cfg?.provider ?? null,
  });
};
