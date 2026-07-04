import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  providerListHandler,
  providerSetHandler,
  providerTestHandler,
  modelListHandler,
  keySetHandler,
  keyClearHandler,
  keyStatusHandler,
  healthHandler,
  __setClientFactory,
  __resetClientFactory,
} from './copilot-tools.js';
import { __resetChatState, registerChatRoutes } from '../../chat/chat-server.js';
import { setDefaultSender, type Sender } from '../tool-executor.js';
import type { LLMClient } from '../../agents/llm-client.js';

function textOf(result: { content: Array<{ type: 'text'; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  __resetChatState();
  __resetClientFactory();
});
afterEach(() => {
  __resetChatState();
  __resetClientFactory();
});

describe('copilot_provider_list / copilot_provider_set — config store round-trip', () => {
  it('lists the catalog with nothing active by default', async () => {
    const res = await providerListHandler({}, {});
    const data = textOf(res) as { providers: Array<{ id: string; active: boolean }>; active_provider: string | null };
    expect(data.active_provider).toBeNull();
    expect(data.providers.some((p) => p.id === 'anthropic')).toBe(true);
    expect(data.providers.every((p) => !p.active)).toBe(true);
  });

  it('set then list round-trips the active provider + model, masking the key', async () => {
    const setRes = await keySetHandler({ provider: 'anthropic', api_key: 'sk-ant-abcd1234' }, {});
    expect(textOf(setRes)).toMatchObject({ ok: true, provider: 'anthropic', key_last4: '1234' });

    const provRes = await providerSetHandler({ provider: 'anthropic', model: 'claude-opus-4-8' }, {});
    expect(textOf(provRes)).toMatchObject({ ok: true, provider: 'anthropic', model: 'claude-opus-4-8' });

    const listRes = await providerListHandler({}, {});
    const data = textOf(listRes) as { providers: Array<{ id: string; active: boolean; key_configured: boolean; key_last4: string | null }>; active_provider: string };
    expect(data.active_provider).toBe('anthropic');
    const active = data.providers.find((p) => p.id === 'anthropic')!;
    expect(active.active).toBe(true);
    // key survives provider_set (same provider) — round-tripped from the earlier key_set
    expect(active.key_configured).toBe(true);
    expect(active.key_last4).toBe('1234');
  });

  it('switching to a different provider drops the previous provider key (M2 rule)', async () => {
    await keySetHandler({ provider: 'anthropic', api_key: 'sk-ant-xxxx1111' }, {});
    await providerSetHandler({ provider: 'anthropic' }, {});
    await providerSetHandler({ provider: 'openai' }, {});

    const status = textOf(await keyStatusHandler({}, {})) as { providers: Array<{ provider: string; configured: boolean }> };
    expect(status.providers.find((p) => p.provider === 'openai')!.configured).toBe(false);
    expect(status.providers.find((p) => p.provider === 'anthropic')!.configured).toBe(false);
  });

  it('rejects an unknown provider', async () => {
    const res = await providerSetHandler({ provider: 'not-a-real-provider' }, {});
    expect(res.isError).toBe(true);
  });
});

describe('copilot_key_set / copilot_key_clear', () => {
  it('key_clear on the active provider clears the key but keeps provider/model', async () => {
    await keySetHandler({ provider: 'openai', api_key: 'sk-openai-999' }, {});
    await providerSetHandler({ provider: 'openai', model: 'gpt-4o-mini' }, {});

    const clearRes = await keyClearHandler({ provider: 'openai' }, {});
    expect(textOf(clearRes)).toMatchObject({ ok: true, provider: 'openai', cleared: true });

    const status = textOf(await keyStatusHandler({}, {})) as { providers: Array<{ provider: string; configured: boolean }> };
    expect(status.providers.find((p) => p.provider === 'openai')!.configured).toBe(false);

    const list = textOf(await providerListHandler({}, {})) as { active_provider: string };
    expect(list.active_provider).toBe('openai'); // provider/model untouched by key_clear
  });

  it('key_clear on a provider with nothing configured is a no-op, not an error', async () => {
    const res = await keyClearHandler({ provider: 'groq' }, {});
    expect(textOf(res)).toMatchObject({ ok: true, provider: 'groq', cleared: false });
    expect(res.isError).toBeFalsy();
  });

  it('key_set requires both provider and api_key', async () => {
    expect((await keySetHandler({ provider: 'openai' }, {})).isError).toBe(true);
    expect((await keySetHandler({ api_key: 'x' }, {})).isError).toBe(true);
  });
});

describe('copilot_key_status', () => {
  it('reports configured:false for every provider before any key is set', async () => {
    const data = textOf(await keyStatusHandler({}, {})) as { providers: Array<{ configured: boolean }> };
    expect(data.providers.every((p) => !p.configured)).toBe(true);
  });
});

describe('key-safety canary — no handler ever returns the raw key', () => {
  const RAW_KEY = 'sk-canary-do-not-leak-XYZQ';

  it('scans every copilot_* result for the raw key substring', async () => {
    await keySetHandler({ provider: 'anthropic', api_key: RAW_KEY }, {});
    await providerSetHandler({ provider: 'anthropic' }, {});

    const results = await Promise.all([
      providerListHandler({}, {}),
      providerSetHandler({ provider: 'anthropic' }, {}),
      modelListHandler({ provider: 'anthropic' }, {}),
      keyStatusHandler({}, {}),
      healthHandler({}, {}),
    ]);
    for (const r of results) {
      const text = r.content.map((c) => c.text).join('\n');
      expect(text).not.toContain(RAW_KEY);
    }
  });
});

describe('copilot_model_list', () => {
  it('is advisory and includes the configured + default model', async () => {
    await providerSetHandler({ provider: 'anthropic', model: 'claude-sonnet-4-8' }, {});
    const data = textOf(await modelListHandler({ provider: 'anthropic' }, {})) as {
      known_models: string[];
      configured_model: string;
      advisory: boolean;
    };
    expect(data.advisory).toBe(true);
    expect(data.configured_model).toBe('claude-sonnet-4-8');
    expect(data.known_models).toContain('claude-sonnet-4-8');
    expect(data.known_models).toContain('claude-opus-4-8'); // catalog default
  });

  it('rejects an unknown provider', async () => {
    expect((await modelListHandler({ provider: 'nope' }, {})).isError).toBe(true);
  });
});

describe('copilot_provider_test — preflight (no network)', () => {
  it('fails clean with no_key when the provider needs a key and none is configured', async () => {
    await providerSetHandler({ provider: 'anthropic' }, {});
    const data = textOf(await providerTestHandler({}, {})) as { ok: boolean; reason?: string };
    expect(data).toEqual({ ok: false, reason: 'no_key' });
  });

  it('does not call the client factory during the no_key preflight', async () => {
    const factory = vi.fn();
    __setClientFactory(factory as unknown as typeof factory);
    await providerSetHandler({ provider: 'anthropic' }, {});
    await providerTestHandler({}, {});
    expect(factory).not.toHaveBeenCalled();
  });

  it('reports ok:true on a mocked successful completion', async () => {
    await keySetHandler({ provider: 'anthropic', api_key: 'sk-ant-good' }, {});
    await providerSetHandler({ provider: 'anthropic' }, {});
    __setClientFactory(() => ({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      protocol: 'anthropic',
      async complete() {
        return { content: 'pong', toolCalls: [], stopReason: 'end_turn' as const };
      },
      async *stream() {},
    } as unknown as LLMClient));

    const data = textOf(await providerTestHandler({}, {})) as { ok: boolean; model?: string; latency_ms?: number };
    expect(data.ok).toBe(true);
    expect(data.model).toBe('claude-opus-4-8');
    expect(typeof data.latency_ms).toBe('number');
  });

  it('maps an auth failure from the client to reason:auth_failed', async () => {
    await keySetHandler({ provider: 'anthropic', api_key: 'sk-ant-bad' }, {});
    await providerSetHandler({ provider: 'anthropic' }, {});
    __setClientFactory(() => ({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      protocol: 'anthropic',
      async complete() {
        const err = new Error('invalid api key') as Error & { kind: string };
        err.kind = 'auth';
        throw err;
      },
      async *stream() {},
    } as unknown as LLMClient));

    const data = textOf(await providerTestHandler({}, {})) as { ok: boolean; reason?: string };
    expect(data.ok).toBe(false);
    expect(data.reason).toBe('auth_failed');
  });

  it('mock provider needs no key and can be probed directly', async () => {
    __setClientFactory(() => ({
      provider: 'mock',
      model: 'mock',
      protocol: 'anthropic',
      async complete() {
        return { content: 'echo: ping', toolCalls: [], stopReason: 'end_turn' as const };
      },
      async *stream() {},
    } as unknown as LLMClient));
    const data = textOf(await providerTestHandler({ provider: 'mock' }, {})) as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});

describe('copilot_health', () => {
  beforeEach(() => setDefaultSender(undefined as never));
  afterEach(() => setDefaultSender(undefined as never));

  it('reports sidecar_ok=false and ue_connected=false before anything is wired up', async () => {
    const data = textOf(await healthHandler({}, {})) as {
      sidecar_ok: boolean;
      ue_connected: boolean;
      tools_available: number;
      active_provider: string | null;
    };
    expect(data.sidecar_ok).toBe(false);
    expect(data.ue_connected).toBe(false);
    // tools_available reflects listRecordedCommands(), which is populated by
    // src/tools/index.ts's module-scope recordToolSchema loop — not loaded by
    // this test file in isolation, so only assert the field's shape here.
    expect(typeof data.tools_available).toBe('number');
    expect(data.tools_available).toBeGreaterThanOrEqual(0);
    expect(data.active_provider).toBeNull();
  });

  it('reports sidecar_ok=true once chat routes are registered', async () => {
    const fakeApp = { post: vi.fn(), get: vi.fn() };
    registerChatRoutes(fakeApp as never);
    const data = textOf(await healthHandler({}, {})) as { sidecar_ok: boolean };
    expect(data.sidecar_ok).toBe(true);
  });

  it('reports ue_connected=true when the UE bridge answers', async () => {
    const okSender: Sender = async () => ({ id: 't', ok: true, data: {} });
    setDefaultSender(okSender);
    const data = textOf(await healthHandler({}, {})) as { ue_connected: boolean };
    expect(data.ue_connected).toBe(true);
  });
});
