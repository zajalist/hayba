/**
 * Issue #30 — cache-hit usage metrics must reach the SSE `done` frame.
 *
 * The frame contract in chat-server.ts's own doc comment already promises
 * `usage?` on the `done` event; this test proves it is actually populated
 * end-to-end: fake LLMClient reports usage -> agent loop sums it -> chat
 * server's `done` SSE frame carries it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { registerChatRoutes, __resetChatState } from './chat-server.js';
import type { LLMClient, LLMResponse, LLMStreamEvent } from '../agents/llm-client.js';
import { temporarySessionStore } from './session-store.test-helpers.js';

function usageClient(usage: LLMResponse['usage']): LLMClient {
  return {
    provider: 'anthropic',
    model: 'fake',
    protocol: 'anthropic',
    async complete() {
      return { content: 'hi', toolCalls: [], stopReason: 'end_turn', usage };
    },
    async *stream(): AsyncGenerator<LLMStreamEvent, void, unknown> {
      yield { type: 'text_delta', text: 'hi' };
      yield {
        type: 'done',
        response: { content: 'hi', toolCalls: [], stopReason: 'end_turn', usage },
      };
    },
  };
}

async function collectSse(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames: Array<{ event: string; data: unknown }> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const eventLine = chunk.split('\n').find((l) => l.startsWith('event: '));
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (eventLine && dataLine) {
        frames.push({
          event: eventLine.slice('event: '.length),
          data: JSON.parse(dataLine.slice('data: '.length)),
        });
        if (eventLine.slice('event: '.length) === 'done') return frames;
      }
    }
  }
  return frames;
}

describe('chat-server SSE done frame — usage metrics (Issue #30)', () => {
  let server: Server;
  let url: string;

  afterEach(() => {
    server?.close();
    __resetChatState();
  });

  it('surfaces cache_creation/cache_read token counts on the final done frame', async () => {
    __resetChatState();
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, {
      sessionStore: temporarySessionStore(),
      createClient: () =>
        usageClient({
          inputTokens: 50,
          outputTokens: 5,
          cacheCreationInputTokens: 300,
          cacheReadInputTokens: 1200,
        }),
      dispatchTool: async () => ({ ok: true }),
      tools: [],
    });
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;

    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', provider: 'anthropic' }),
    });
    const frames = await collectSse(res as unknown as Response);
    const done = frames.find((f) => f.event === 'done');
    expect(done).toBeDefined();
    expect((done!.data as { usage?: unknown }).usage).toEqual({
      inputTokens: 50,
      outputTokens: 5,
      cacheCreationInputTokens: 300,
      cacheReadInputTokens: 1200,
    });
  });

  it('omits usage when the client never reports it (no false metrics)', async () => {
    __resetChatState();
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, {
      sessionStore: temporarySessionStore(),
      createClient: () => usageClient(undefined),
      dispatchTool: async () => ({ ok: true }),
      tools: [],
    });
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;

    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', provider: 'anthropic' }),
    });
    const frames = await collectSse(res as unknown as Response);
    const done = frames.find((f) => f.event === 'done');
    expect(done).toBeDefined();
    expect((done!.data as { usage?: unknown }).usage).toBeUndefined();
  });

  it('exposes unreviewed validator IDs on the final SSE frame', async () => {
    __resetChatState();
    const app = express();
    app.use(express.json());
    let turn = 0;
    const client: LLMClient = {
      provider: 'anthropic', model: 'fake', protocol: 'anthropic',
      async complete() { return { content: 'done', toolCalls: [], stopReason: 'end_turn' }; },
      async *stream(): AsyncGenerator<LLMStreamEvent, void, unknown> {
        turn += 1;
        yield { type: 'done', response: turn === 1
          ? { content: null, toolCalls: [{ id: 'warn1', name: 'validator_run', input: {} }], stopReason: 'tool_use' }
          : { content: 'Reviewed later.', toolCalls: [], stopReason: 'end_turn' } };
      },
    };
    registerChatRoutes(app, {
      createClient: () => client,
      dispatchTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ validator: { warning_ids: ['ui_engine_default_font'] } }) }] }),
      tools: [{ name: 'validator_run', description: 'validate', input_schema: { type: 'object', properties: {} } }],
    });
    server = app.listen(0);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${url}/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'check fonts', provider: 'anthropic' }),
    });
    const frames = await collectSse(res as unknown as Response);
    const done = frames.find((f) => f.event === 'done')?.data as { reason: string; pending_warning_ids?: string[] };
    expect(done.reason).toBe('warnings_unreviewed');
    expect(done.pending_warning_ids).toEqual(['ui_engine_default_font']);
  });
});
