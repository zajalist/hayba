import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerChatRoutes, __resetChatState } from './chat-server.js';
import { temporarySessionStore } from './session-store.test-helpers.js';
import type { LLMClient, LLMClientConfig } from '../agents/llm-client.js';

describe('DeepSeek Community chat', () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); __resetChatState(); });

  it('accepts the preset and passes its own configured key to the Community client', async () => {
    const configs: LLMClientConfig[] = [];
    const client: LLMClient = {
      provider: 'deepseek', model: 'deepseek-flash', protocol: 'openai',
      complete: async () => ({ content: 'ok', toolCalls: [], stopReason: 'end_turn' }),
      async *stream() {
        yield { type: 'text_delta' as const, text: 'ok' };
        yield { type: 'done' as const, response: { content: 'ok', toolCalls: [], stopReason: 'end_turn' as const } };
      },
    };
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, {
      sessionStore: temporarySessionStore(),
      createClient: (config) => { configs.push(config); return client; },
      dispatchTool: vi.fn(async () => ({ ok: true })), tools: [],
    });
    server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { 'content-type': 'application/json' };
    const configured = await fetch(`${base}/chat/config`, {
      method: 'POST', headers,
      body: JSON.stringify({ provider: 'deepseek', api_key: 'synthetic-deepseek-key' }),
    });
    expect(configured.status).toBe(200);
    const configResponse = await configured.json();
    expect(configResponse).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash' });
    expect(JSON.stringify(configResponse)).not.toContain('synthetic-deepseek-key');

    const streamed = await fetch(`${base}/chat/stream`, {
      method: 'POST', headers,
      body: JSON.stringify({ prompt: 'hello', loop: 'community' }),
    });
    const sse = await streamed.text();
    expect(sse).toContain('event: done');
    expect(configs).toEqual([{ provider: 'deepseek', model: undefined, baseURL: undefined, apiKey: 'synthetic-deepseek-key' }]);
    expect(sse).not.toContain('synthetic-deepseek-key');
  });
});
