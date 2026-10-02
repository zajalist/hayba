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
import { discoverModels } from '../../agents/model-discovery.js';
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
// copilot_model_list — read-only provider discovery, with manual ID fallback.
// ---------------------------------------------------------------------------

export const modelListMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'picking a model id for a provider before calling copilot_provider_set',
  not_when: 'you already have a model id in hand — manual entry remains allowed',
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
  const matches = cfg?.provider === provider;
  const configuredModel = matches ? cfg?.model : undefined;
  const discovered = await discoverModels({
    provider,
    apiKey: matches ? cfg?.apiKey : undefined,
    baseURL: matches ? cfg?.baseURL : undefined,
    currentModel: configuredModel,
  });
  const knownModels = discovered.status === 'ok' || discovered.status === 'partial'
    ? discovered.models.map((m) => m.id) : [];
  return ok({
    provider,
    default_model: knownModels.includes(entry.defaultModel) ? entry.defaultModel : null,
    configured_model: configuredModel ?? null,
    known_models: knownModels,
    models: discovered.models,
    discovery_status: discovered.status,
    stale: discovered.stale,
    reason: discovered.reason ?? null,
    retry_after_seconds: discovered.retry_after_seconds ?? null,
    fetched_at: discovered.fetched_at,
    manual_entry_allowed: true,
    advisory: true,
    note: discovered.note ?? 'Listed IDs are availability evidence, not a ranking or a model validator.',
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
    await executeCommand('hayba_check_ue_status', {}, { timeout: 2000 });
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
