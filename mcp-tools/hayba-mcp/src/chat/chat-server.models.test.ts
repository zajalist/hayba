import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { __resetChatState, registerChatRoutes } from './chat-server.js';
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
});
