import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { __resetChatState, getConfigEntry, registerChatRoutes, setConfigEntry } from './chat-server.js';
import { __resetModelDiscovery, __setModelDiscoveryFetch } from '../agents/model-discovery.js';
import { temporarySessionStore } from './session-store.test-helpers.js';

describe('loopback model discovery for Settings', () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); __resetChatState(); __resetModelDiscovery(); });

  async function start(): Promise<string> {
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, { sessionStore: temporarySessionStore(), tools: [], dispatchTool: async () => ({}) });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server!.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('reads the configured provider key only, returns metadata, and never echoes secrets', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.deepseek.com/models');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-deepseek-key' });
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash', name: 'Flash', context_window: 1000000,
        max_output_tokens: 384000, input_modalities: ['text', 'image'], output_modalities: ['text'],
        effort: { supported_levels: ['low', 'high'] } }] }), { status: 200 });
    });
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const base = await start();
    const configured = await fetch(`${base}/chat/config`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash', api_key: 'synthetic-deepseek-key' }) });
    expect(configured.status).toBe(200);
    const response = await fetch(`${base}/chat/models?provider=deepseek&refresh=1`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ provider: 'deepseek', status: 'ok', configured_model: 'deepseek-flash',
      default_model: 'deepseek-flash', models: [{ id: 'deepseek-flash', context_tokens: 1000000, reasoning_efforts: ['low', 'high'] }] });
    expect(JSON.stringify(body)).not.toContain('synthetic-deepseek-key');
    const other = await fetch(`${base}/chat/models?provider=openai`);
    expect((await other.json()).status).toBe('no_key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate or malformed selectors without touching a provider', async () => {
    const fetchMock = vi.fn();
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const base = await start();
    for (const query of ['provider=deepseek&provider=openai', 'provider=not-real', 'provider=deepseek&refresh=yes']) {
      expect((await fetch(`${base}/chat/models?${query}`)).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revokes only temporary Settings config, including a delayed POST, while live chat config survives', async () => {
    const base = await start();
    const settingsId = 'ue_settings_0123456789abcdef0123456789abcdef';
    const lateId = 'ue_settings_fedcba9876543210fedcba9876543210';
    const postConfig = (body: object) => fetch(`${base}/chat/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await postConfig({ provider: 'deepseek', api_key: 'default-secret' })).status).toBe(200);
    expect((await postConfig({ session_id: 'live_chat_1', provider: 'openai', api_key: 'live-secret' })).status).toBe(200);
    expect((await postConfig({ session_id: settingsId, provider: 'openai', api_key: 'settings-secret' })).status).toBe(200);
    const masked = await (await fetch(`${base}/chat/config?session_id=${settingsId}`)).json();
    expect(masked).toMatchObject({ configured: true, provider: 'openai', key_last4: 'cret' });
    expect(JSON.stringify(masked)).not.toContain('settings-secret');

    expect((await fetch(`${base}/chat/config?session_id=live_chat_1`, { method: 'DELETE' })).status).toBe(403);
    expect((await fetch(`${base}/chat/config?session_id=${settingsId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${base}/chat/config?session_id=${settingsId}`, { method: 'DELETE' })).status).toBe(204);
    expect(getConfigEntry(settingsId)).toBeUndefined();
    expect(await (await fetch(`${base}/chat/config?session_id=${settingsId}`)).json()).toEqual({ configured: false });
    expect((await fetch(`${base}/chat/models?provider=openai&session_id=${settingsId}`)).status).toBe(410);
    expect((await postConfig({ session_id: settingsId, provider: 'openai', api_key: 'late-secret' })).status).toBe(410);
    expect(getConfigEntry()).toMatchObject({ provider: 'deepseek', apiKey: 'default-secret' });
    expect(getConfigEntry('live_chat_1')).toMatchObject({ provider: 'openai', apiKey: 'live-secret' });

    // DELETE may beat the cancelled POST over the network. Its tombstone must
    // still prevent the later POST from leaving a key in memory.
    expect((await fetch(`${base}/chat/config?session_id=${lateId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await postConfig({ session_id: lateId, provider: 'openai', api_key: 'late-secret' })).status).toBe(410);
    expect(getConfigEntry(lateId)).toBeUndefined();
    expect((await postConfig({ session_id: 'ue_settings_bad', provider: 'openai', api_key: 'bad' })).status).toBe(400);
  });

  it('expires temporary Settings config after two minutes without falling back to the default key', async () => {
    const base = await start();
    const settingsId = 'ue_settings_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const postConfig = (body: object) => fetch(`${base}/chat/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await postConfig({ provider: 'openai', api_key: 'default-secret' })).status).toBe(200);
    expect((await postConfig({ session_id: settingsId, provider: 'openai', api_key: 'short-lived-secret' })).status).toBe(200);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 120_001);
    try {
      expect(getConfigEntry(settingsId)).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
    expect((await fetch(`${base}/chat/models?provider=openai&session_id=${settingsId}`)).status).toBe(410);
    expect(await (await fetch(`${base}/chat/config?session_id=${settingsId}`)).json()).toEqual({ configured: false });
    expect(getConfigEntry()).toMatchObject({ provider: 'openai', apiKey: 'default-secret' });
  });

  it('also removes an unobserved temporary key when its expiry timer fires', () => {
    const settingsId = 'ue_settings_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const timer = vi.spyOn(globalThis, 'setTimeout');
    try {
      setConfigEntry(settingsId, { provider: 'openai', apiKey: 'short-lived-secret' });
      const expiry = timer.mock.calls.find(([, delay]) => delay === 120_000);
      expect(expiry).toBeDefined();
      (expiry?.[0] as () => void)();
      expect(getConfigEntry(settingsId)).toBeUndefined();
    } finally {
      timer.mockRestore();
    }
  });
});
