import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerChatRoutes, __resetChatState } from './chat-server.js';
import { temporarySessionStore } from './session-store.test-helpers.js';
import { createLLMClient, type LLMClient, type LLMClientConfig, type OpenAIClientLike } from '../agents/llm-client.js';

describe('DeepSeek Community chat', () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); __resetChatState(); });

  async function startWithSDK(openai: OpenAIClientLike) {
    const store = temporarySessionStore();
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, {
      sessionStore: store,
      createClient: (config) => createLLMClient(config, { openai }),
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
    return { base, headers, store };
  }

  function sdkStream(chunks: unknown[]): OpenAIClientLike {
    return { chat: { completions: { create: vi.fn(async () => (async function* () {
      for (const chunk of chunks) yield chunk;
    })()) } } };
  }

  it('passes the chosen model, effort, and configured key to the Community client', async () => {
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
      body: JSON.stringify({ prompt: 'hello', loop: 'community', model: 'deepseek-selected', reasoning_effort: 'low' }),
    });
    const sse = await streamed.text();
    expect(sse).toContain('event: done');
    expect(configs).toEqual([{ provider: 'deepseek', model: 'deepseek-selected',
      reasoningEffort: 'low', baseURL: undefined, apiKey: 'synthetic-deepseek-key' }]);
    expect(sse).not.toContain('synthetic-deepseek-key');
  });

  it('turns SDK-shaped DeepSeek chunks into a visible and saved assistant reply', async () => {
    const openai = sdkStream([
      { choices: [{ delta: { content: 'Hello from ' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'DeepSeek.' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } },
    ]);
    const { base, headers, store } = await startWithSDK(openai);
    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: 'hello', loop: 'community' }),
    });
    const sessionId = response.headers.get('x-hayba-session-id');
    const sse = await response.text();
    expect(response.status).toBe(200);
    expect(sse).toContain('event: text_delta');
    expect(sse).toContain('"text":"Hello from "');
    expect(sse).toContain('"text":"DeepSeek."');
    expect(sse).toContain('"assistant_text":"Hello from DeepSeek."');
    expect(sse).toContain('"reason":"end_turn"');
    expect(sse).not.toContain('event: error');
    expect(store.load(sessionId!)?.messages.at(-1)).toEqual({ role: 'assistant', content: 'Hello from DeepSeek.' });
    expect(sse).not.toContain('synthetic-deepseek-key');
  });

  it('reports an empty DeepSeek stop instead of silently saving a user-only success', async () => {
    const { base, headers, store } = await startWithSDK(sdkStream([
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));
    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: 'hello', loop: 'community' }),
    });
    const sse = await response.text();
    expect(sse).toContain('event: error');
    expect(sse).toContain('"kind":"provider_protocol"');
    expect(sse).toContain('"reason":"provider_protocol_error"');
    expect(sse).toContain('"assistant_text":""');
    expect(store.load(response.headers.get('x-hayba-session-id')!)?.messages).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  it('surfaces a DeepSeek API rejection as an SSE error and terminal frame', async () => {
    const openai: OpenAIClientLike = { chat: { completions: {
      create: vi.fn(async () => {
        throw Object.assign(new Error('rejected synthetic-deepseek-key and private-prompt-marker'), { status: 401 });
      }),
    } } };
    const { base, headers } = await startWithSDK(openai);
    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: 'private-prompt-marker', loop: 'community' }),
    });
    const sse = await response.text();
    expect(sse).toContain('event: error');
    expect(sse).toContain('"kind":"auth"');
    expect(sse).toContain('event: done');
    expect(sse).toContain('"reason":"error"');
    expect(sse).not.toContain('synthetic-deepseek-key');
    expect(sse).not.toContain('private-prompt-marker');
  });
});
