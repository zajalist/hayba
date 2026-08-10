import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '../logger.js';
import {
  createLLMClient,
  LLMError,
  normalizeOpenAIBaseURL,
  type LLMCompleteParams,
  type LLMStreamEvent,
} from './llm-client.js';

interface SeenRequest {
  url: string;
  authorization: string;
  body: Record<string, unknown>;
}

const seen: SeenRequest[] = [];
let origin = '';
let server: ReturnType<typeof createServer>;
let originalFetch: typeof globalThis.fetch;
const escapedURLs: string[] = [];

function params(text = 'hello'): LLMCompleteParams {
  return {
    system: 'You are a compatibility probe.',
    messages: [{ role: 'user', content: text }],
    tools: [
      {
        name: 'actor_list',
        description: 'List actors',
        input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
      },
    ],
  };
}

function completion(model: string, finishReason: string, content: string | null = 'complete-ok') {
  return {
    id: `chatcmpl-${model}`,
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'local-request' });
  res.end(JSON.stringify(value));
}

function sse(res: ServerResponse, value: unknown): void {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function readJSON(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 128 * 1_024) throw new Error('test request exceeded 128 KiB');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    try {
      const body = await readJSON(req);
      seen.push({
        url: req.url ?? '',
        authorization: String(req.headers.authorization ?? ''),
        body,
      });
      const model = String(body.model ?? '');
      if (model === 'network-close') {
        req.socket.destroy();
        return;
      }
      if (model === 'abort' || model === 'timeout') {
        // The client must close this request through AbortSignal / SDK timeout.
        return;
      }
      if (model === 'api-error') {
        json(res, 400, {
          error: {
            message: JSON.stringify({
              authorization: req.headers.authorization,
              request_body: body,
              api_key: 'sk-response-secret-1234567890',
              nested: { client_secret: 'response-client-secret-123456' },
            }),
            type: 'invalid_request_error',
            code: 'bad_request',
          },
        });
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, {
          id: 'chatcmpl-stream',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }],
        });
        sse(res, {
          id: 'chatcmpl-stream',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [
            {
              index: 0,
              delta: {
                content: 'lo',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_local',
                    type: 'function',
                    function: { name: 'actor_list', arguments: '{"limit":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        sse(res, {
          id: 'chatcmpl-stream',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '3}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        });
        sse(res, {
          id: 'chatcmpl-stream',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [],
          usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 },
        });
        res.end('data: [DONE]\n\n');
        return;
      }
      if (model === 'length') return json(res, 200, completion(model, 'length'));
      if (model === 'content-filter') return json(res, 200, completion(model, 'content_filter', null));
      if (model === 'new-finish-reason') return json(res, 200, completion(model, 'future_reason'));
      json(res, 200, completion(model, 'stop'));
    } catch {
      if (!res.headersSent) json(res, 400, { error: { message: 'invalid local request' } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;

  // A test regression must fail locally instead of making a billable/external
  // request. The real SDK still drives the guarded native fetch implementation.
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== origin) {
      escapedURLs.push(url.toString());
      throw new Error('real-client smoke attempted to escape its local endpoint');
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('OpenAI 7 published client compatibility', () => {
  it('uses the lazy real constructor for complete(), canonicalizes baseURL, and reports usage', async () => {
    const apiKey = 'sk-local-real-client-1234567890';
    const client = createLLMClient({
      provider: 'custom',
      model: 'complete',
      baseURL: `${origin}/v1///`,
      apiKey,
    });

    const response = await client.complete(params());
    expect(response).toMatchObject({
      content: 'complete-ok',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    const request = seen.find((entry) => entry.body.model === 'complete');
    expect(request).toMatchObject({ url: '/v1/chat/completions', authorization: `Bearer ${apiKey}` });
    expect(request?.body).toMatchObject({ model: 'complete' });
    expect(request?.body.stream).toBeUndefined();
    expect(escapedURLs).toEqual([]);
  });

  it('sends the no-key placeholder only to the configured compatible endpoint', async () => {
    const client = createLLMClient({ provider: 'custom', model: 'placeholder', baseURL: `${origin}/v1/` });
    await client.complete(params());
    const request = seen.find((entry) => entry.body.model === 'placeholder');
    expect(request).toMatchObject({ url: '/v1/chat/completions', authorization: 'Bearer not-needed' });
    expect(escapedURLs).toEqual([]);
  });

  it('streams text, tool-call fragments, finish reason, and usage through the real SDK parser', async () => {
    const client = createLLMClient({ provider: 'custom', model: 'stream', baseURL: `${origin}/v1` });
    const events: LLMStreamEvent[] = [];
    for await (const event of client.stream(params())) events.push(event);

    expect(events.slice(0, 2)).toEqual([
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
    ]);
    expect(events.at(-2)).toEqual({
      type: 'tool_call',
      call: { id: 'call_local', name: 'actor_list', input: { limit: 3 } },
    });
    expect(events.at(-1)).toEqual({
      type: 'done',
      response: {
        content: 'hello',
        toolCalls: [{ id: 'call_local', name: 'actor_list', input: { limit: 3 } }],
        stopReason: 'tool_use',
        usage: { inputTokens: 13, outputTokens: 5 },
      },
    });
    const request = seen.find((entry) => entry.body.model === 'stream');
    expect(request?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('preserves length, content-filter, and unknown finish reasons instead of claiming end_turn', async () => {
    const complete = async (model: string) =>
      createLLMClient({
        provider: 'custom',
        model,
        baseURL: `${origin}/v1`,
      }).complete(params());
    await expect(complete('length')).resolves.toMatchObject({ stopReason: 'max_tokens' });
    await expect(complete('content-filter')).resolves.toMatchObject({ stopReason: 'content_filter' });
    await expect(complete('new-finish-reason')).resolves.toMatchObject({ stopReason: 'unknown' });
  });

  it('propagates AbortSignal cancellation through the published client', async () => {
    const controller = new AbortController();
    const client = createLLMClient({ provider: 'custom', model: 'abort', baseURL: `${origin}/v1` });
    const request = params('cancel me');
    request.signal = controller.signal;
    const pending = client.complete(request).catch((error: unknown) => error as LLMError);
    setTimeout(() => controller.abort(), 20);
    const error = await pending;
    expect(error).toBeInstanceOf(LLMError);
    expect(error).toMatchObject({ kind: 'network', message: expect.stringContaining('aborted') });
    expect(seen.some((entry) => entry.body.model === 'abort')).toBe(true);
  });

  it('classifies SDK timeout and connection reset as network errors', async () => {
    const timed = createLLMClient({
      provider: 'custom',
      model: 'timeout',
      baseURL: `${origin}/v1`,
      timeoutMs: 20,
    });
    await expect(timed.complete(params())).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('timed out'),
    });
    expect(seen.some((entry) => entry.body.model === 'timeout')).toBe(true);

    const reset = createLLMClient({ provider: 'custom', model: 'network-close', baseURL: `${origin}/v1` });
    await expect(reset.complete(params())).rejects.toMatchObject({ kind: 'network' });
  }, 10_000);

  it('maps non-2xx errors without leaking auth, request bodies, or secret response fields to diagnostics/logs', async () => {
    const apiKey = 'sk-local-diagnostic-1234567890';
    const requestSecret = 'Authorization: Bearer sk-request-body-secret-1234567890';
    const client = createLLMClient({ provider: 'custom', model: 'api-error', baseURL: `${origin}/v1`, apiKey });
    let error: LLMError | undefined;
    try {
      await client.complete(params(requestSecret));
    } catch (caught) {
      error = caught as LLMError;
    }

    expect(error).toMatchObject({ kind: 'api', status: 400 });
    expect(error?.message).toContain('HTTP 400');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    log('error', error!.message);
    const diagnostic = JSON.stringify([error!.message, stderr.mock.calls]);
    stderr.mockRestore();
    for (const secret of [
      apiKey,
      requestSecret,
      'sk-request-body-secret-1234567890',
      'sk-response-secret-1234567890',
      'response-client-secret-123456',
    ]) {
      expect(diagnostic).not.toContain(secret);
    }
  });
});

describe('OpenAI-compatible endpoint confinement', () => {
  it('requires custom endpoints and rejects URL authority/query tricks before importing or fetching', () => {
    expect(() => createLLMClient({ provider: 'custom', model: 'x' })).toThrow(/explicit base URL/);
    expect(() => normalizeOpenAIBaseURL('ftp://127.0.0.1/v1')).toThrow(/HTTP\(S\)/);
    expect(() => normalizeOpenAIBaseURL('http://user:pass@127.0.0.1/v1')).toThrow(/without credentials/);
    expect(() => normalizeOpenAIBaseURL(`${origin}/v1?api_key=secret`)).toThrow(/query string/);
    expect(() => normalizeOpenAIBaseURL(`${origin}\\@example.com/v1`)).toThrow(/invalid/);
    expect(escapedURLs).toEqual([]);
  });
});
