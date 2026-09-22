import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { registerChatRoutes, __resetChatState } from './chat-server.js';
import type { LLMClient, LLMCompleteParams, LLMResponse, LLMStreamEvent } from '../agents/llm-client.js';
import { SessionStore, type SavedSession } from './session-store.js';

class SecretToolClient implements LLMClient {
  provider = 'mock';
  model = 'fake';
  protocol = 'anthropic' as const;
  private turn = 0;

  async complete(): Promise<LLMResponse> {
    throw new Error('not used');
  }

  async *stream(_params: LLMCompleteParams): AsyncGenerator<LLMStreamEvent, void, unknown> {
    this.turn += 1;
    const response: LLMResponse =
      this.turn === 1
        ? {
            content: null,
            toolCalls: [
              {
                id: 'secret-call',
                name: 'actor_list',
                input: { apiKey: 'SENTINEL_SSE_INPUT', query: 'RAW_ARGUMENT_CANARY' },
              },
            ],
            stopReason: 'tool_use',
          }
        : {
            content: 'Authorization: Bearer SENTINEL_ASSISTANT_123456 then done',
            toolCalls: [],
            stopReason: 'end_turn',
          };
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
      const event = chunk
        .split('\n')
        .find((line) => line.startsWith('event: '))
        ?.slice(7);
      const data = chunk
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6);
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
  let directory: string;
  let sessionStore: SessionStore;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hayba-chat-sessions-'));
    sessionStore = new SessionStore(directory);
  });

  afterEach(() => {
    server?.close();
    __resetChatState();
    rmSync(directory, { recursive: true, force: true });
  });

  it('sanitizes tool frames and the buffered final trace before serialization', async () => {
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, {
      sessionStore,
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
    registerChatRoutes(app, { tools: [], sessionStore });
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

  it('persists safe semantic summaries while retaining legacy SSE, then lists, loads and deletes sessions', async () => {
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, {
      sessionStore,
      createClient: () => new SecretToolClient(),
      dispatchTool: async () => ({
        safeLookingField: 'RAW_RESULT_CANARY',
        authorization: 'Bearer SENTINEL_RESULT_123456',
      }),
      tools: [{ name: 'actor_list', description: 'list', input_schema: { type: 'object', properties: {} } }],
    });
    server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const created = await post('/chat/sessions', {});
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as SavedSession;
    await post('/chat/config', { session_id: id, provider: 'mock', api_key: 'SENTINEL_CONFIG' });
    const frames = await collectSse(
      await post('/chat/stream', { session_id: id, prompt: 'api_key=SENTINEL_PROMPT list actors' }),
    );
    expect(frames.map((frame) => frame.event)).toEqual(['tool_call', 'tool_result', 'text_delta', 'done']);
    const loaded = await fetch(`${url}/chat/sessions/${id}`);
    const session = (await loaded.json()) as SavedSession;
    expect(session.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(session.activities).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        steps: [{ name: 'actor_list', status: 'succeeded' }],
      }),
    ]);
    expect(session.activities[0].activityId).toBeTruthy();
    expect(session.activities[0].specialistId).toBeTruthy();
    const bytes = readdirSync(directory)
      .map((file) => readFileSync(join(directory, file), 'utf8'))
      .join('');
    expect(bytes).not.toContain('SENTINEL');
    expect(bytes).not.toContain('RAW_RESULT_CANARY');
    expect(bytes).not.toContain('RAW_ARGUMENT_CANARY');
    expect(bytes).not.toContain('tool_trace');
    expect(await (await fetch(`${url}/chat/sessions`)).json()).toEqual({
      sessions: [expect.objectContaining({ id, messageCount: 2 })],
    });
    await collectSse(await post('/chat/stream', { session_id: id, last_seq: 0 }));
    expect(sessionStore.load(id)?.activities).toHaveLength(1);
    expect((await fetch(`${url}/chat/sessions/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${url}/chat/sessions/${id}`)).status).toBe(404);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('restores text history after restart and appends new prompts without duplicating client-supplied history', async () => {
    const { id } = sessionStore.create();
    sessionStore.append(id, {
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Answer' },
      ],
    });
    const requests: LLMCompleteParams[] = [];
    const client: LLMClient = {
      provider: 'mock',
      model: 'fake',
      protocol: 'anthropic',
      async complete() {
        throw new Error('unused');
      },
      async *stream(params) {
        requests.push(params);
        yield { type: 'text_delta', text: 'Next answer' };
        yield {
          type: 'done',
          response: {
            content: 'Next answer',
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 3, outputTokens: 2 },
          },
        };
      },
    };
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, { sessionStore, createClient: () => client, tools: [] });
    server = app.listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const turn = async (body: unknown) =>
      collectSse(
        await fetch(`${url}/chat/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    await turn({ session_id: id, prompt: 'Next' });
    expect(requests[0].messages.slice(0, 3)).toEqual([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Answer' },
      { role: 'user', content: 'Next' },
    ]);
    const history = sessionStore.load(id)!.messages;
    await turn({ session_id: id, messages: [...history, { role: 'user', content: 'Third' }] });
    expect(sessionStore.load(id)?.messages).toHaveLength(6);
    expect(sessionStore.load(id)?.usage).toEqual({ inputTokens: 6, outputTokens: 4 });
    await turn({ session_id: id, prompt: 'Fourth' });
    expect(requests[2].messages.slice(0, 7).map((message) => message.content)).toEqual([
      'First',
      'Answer',
      'Next',
      'Next answer',
      'Third',
      'Next answer',
      'Fourth',
    ]);
    expect(sessionStore.load(id)?.messages).toHaveLength(8);
  });

  it('rejects malformed session identifiers before starting a stream', async () => {
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, { sessionStore, tools: [] });
    server = app.listen(0);
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: '../outside', prompt: 'go' }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(readdirSync(directory)).toEqual([]);
  });

  it('saves cancellation and incurred usage while refusing deletion of an in-flight session', async () => {
    const { id } = sessionStore.create();
    const client: LLMClient = {
      provider: 'mock',
      model: 'fake',
      protocol: 'anthropic',
      async complete() {
        throw new Error('unused');
      },
      async *stream() {
        yield {
          type: 'done',
          response: {
            content: null,
            toolCalls: [{ id: 'read', name: 'actor_list', input: {} }],
            stopReason: 'tool_use',
            usage: { inputTokens: 5, outputTokens: 2 },
          },
        };
      },
    };
    const app = express();
    app.use(express.json());
    let url: string;
    let deleteStatus: number | undefined;
    registerChatRoutes(app, {
      sessionStore,
      createClient: () => client,
      tools: [{ name: 'actor_list', description: 'list', input_schema: { type: 'object', properties: {} } }],
      dispatchTool: async () => {
        deleteStatus = (await fetch(`${url}/chat/sessions/${id}`, { method: 'DELETE' })).status;
        await fetch(`${url}/chat/cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session_id: id }),
        });
        return {};
      },
    });
    server = app.listen(0);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const frames = await collectSse(
      await fetch(`${url}/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: id, prompt: 'go' }),
      }),
    );
    expect(deleteStatus).toBe(409);
    expect(frames.filter((frame) => frame.event === 'done')).toHaveLength(1);
    expect(sessionStore.load(id)?.activities[0]).toMatchObject({ status: 'cancelled', reason: 'aborted' });
    expect(sessionStore.load(id)?.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });
});
