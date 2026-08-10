import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { registerChatRoutes, __resetChatState } from './chat-server.js';
import type { LLMClient, LLMCompleteParams, LLMResponse, LLMStreamEvent } from '../agents/llm-client.js';

class SecretToolClient implements LLMClient {
  provider = 'mock';
  model = 'fake';
  protocol = 'anthropic' as const;
  private turn = 0;

  async complete(): Promise<LLMResponse> { throw new Error('not used'); }

  async *stream(_params: LLMCompleteParams): AsyncGenerator<LLMStreamEvent, void, unknown> {
    this.turn += 1;
    const response: LLMResponse = this.turn === 1
      ? {
          content: null,
          toolCalls: [{ id: 'secret-call', name: 'actor_list', input: { apiKey: 'SENTINEL_SSE_INPUT' } }],
          stopReason: 'tool_use',
        }
      : { content: 'Authorization: Bearer SENTINEL_ASSISTANT_123456 then done', toolCalls: [], stopReason: 'end_turn' };
    if (response.content) yield { type: 'text_delta', text: response.content };
    for (const call of response.toolCalls) yield { type: 'tool_call', call };
    yield { type: 'done', response };
  }
}

async function collectSse(res: Response): Promise<Array<{ event: string; data: unknown }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: Array<{ event: string; data: unknown }> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return frames;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = chunk.split('\n').find((line) => line.startsWith('event: '))?.slice(7);
      const data = chunk.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
      if (event && data) {
        frames.push({ event, data: JSON.parse(data) });
        if (event === 'done') return frames;
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

describe('chat HTTP/SSE redaction boundary', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    __resetChatState();
  });

  it('sanitizes tool frames and the buffered final trace before serialization', async () => {
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, {
      createClient: () => new SecretToolClient(),
      dispatchTool: async () => ({
        authorization: 'Bearer SENTINEL_SSE_RESULT_123456',
        mandatory_recovery: 'Reconnect after rotating credentials.',
      }),
      tools: [{ name: 'actor_list', description: 'list', input_schema: { type: 'object', properties: {} } }],
    });
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'go', provider: 'mock' }),
    });
    const frames = await collectSse(response);
    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain('SENTINEL');
    expect(serialized).toContain('mandatory_recovery');
    expect(frames.some((frame) => frame.event === 'tool_call')).toBe(true);
    expect(frames.some((frame) => frame.event === 'tool_result')).toBe(true);
    expect(frames.find((frame) => frame.event === 'done')).toBeDefined();
  });

  it('sanitizes ordinary JSON error responses through the same Express adapter', async () => {
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, { tools: [] });
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/chat/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'apiKey=SENTINEL_HTTP' }),
    });
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).not.toContain('SENTINEL_HTTP');
    expect(text).toContain('unknown provider');
  });
});
