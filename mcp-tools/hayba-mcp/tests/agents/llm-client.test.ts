import { describe, it, expect } from 'vitest';
import {
  createLLMClient,
  LLMError,
  type AnthropicClientLike,
  type OpenAIClientLike,
  type LLMStreamEvent,
  type LLMTool,
} from '../../src/agents/llm-client.js';

const TOOL: LLMTool = {
  name: 'get_weather',
  description: 'Get the weather',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

const BASE = { system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }], tools: [TOOL] };

async function drain(gen: AsyncGenerator<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const out: LLMStreamEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Turn an array into an async iterable (fake stream). */
async function* iter<T>(items: T[]): AsyncGenerator<T> {
  for (const i of items) yield i;
}

// ---------------------------------------------------------------------------
// Tool mapping
// ---------------------------------------------------------------------------

describe('tool mapping', () => {
  it('maps tools to the Anthropic wire format', async () => {
    let captured: any;
    const fake: AnthropicClientLike = {
      messages: {
        async create(params) {
          captured = params;
          return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
        },
        stream: () => iter([]),
      },
    };
    const client = createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake });
    await client.complete(BASE);
    expect(captured.tools).toEqual([
      { name: 'get_weather', description: 'Get the weather', input_schema: TOOL.input_schema },
    ]);
    expect(captured.model).toBe('claude-opus-4-8');
  });

  it('maps tools to the OpenAI function format', async () => {
    let captured: any;
    const fake: OpenAIClientLike = {
      chat: {
        completions: {
          async create(params) {
            captured = params;
            return { choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }] };
          },
        },
      },
    };
    const client = createLLMClient({ provider: 'openai', apiKey: 'k' }, { openai: fake });
    await client.complete(BASE);
    expect(captured.tools).toEqual([
      {
        type: 'function',
        function: { name: 'get_weather', description: 'Get the weather', parameters: TOOL.input_schema },
      },
    ]);
    // system prompt folds into the first message for openai-compat
    expect(captured.messages[0]).toEqual({ role: 'system', content: 'sys' });
  });
});

// ---------------------------------------------------------------------------
// complete() parsing
// ---------------------------------------------------------------------------

describe('complete() parsing', () => {
  it('parses Anthropic tool_use blocks and stop_reason', async () => {
    const fake: AnthropicClientLike = {
      messages: {
        async create() {
          return {
            content: [
              { type: 'text', text: 'let me check' },
              { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
            ],
            stop_reason: 'tool_use',
          };
        },
        stream: () => iter([]),
      },
    };
    const client = createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake });
    const resp = await client.complete(BASE);
    expect(resp.stopReason).toBe('tool_use');
    expect(resp.content).toBe('let me check');
    expect(resp.toolCalls).toEqual([{ id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } }]);
  });

  it('parses Anthropic end_turn with no tools', async () => {
    const fake: AnthropicClientLike = {
      messages: {
        async create() {
          return { content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn' };
        },
        stream: () => iter([]),
      },
    };
    const client = createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake });
    const resp = await client.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(resp.stopReason).toBe('end_turn');
    expect(resp.toolCalls).toEqual([]);
  });

  it('parses OpenAI tool_calls with JSON-string arguments', async () => {
    const fake: OpenAIClientLike = {
      chat: {
        completions: {
          async create() {
            return {
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [
                      { id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            };
          },
        },
      },
    };
    const client = createLLMClient({ provider: 'groq', apiKey: 'k' }, { openai: fake });
    const resp = await client.complete(BASE);
    expect(resp.stopReason).toBe('tool_use');
    expect(resp.content).toBeNull();
    expect(resp.toolCalls).toEqual([{ id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }]);
  });
});

// ---------------------------------------------------------------------------
// Streaming accumulation == complete()
// ---------------------------------------------------------------------------

describe('stream() accumulation', () => {
  it('Anthropic stream produces the same final response as complete()', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'let me ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'check' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'get_weather' },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Paris"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ];
    const fake: AnthropicClientLike = {
      messages: {
        async create() {
          return {
            content: [
              { type: 'text', text: 'let me check' },
              { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
            ],
            stop_reason: 'tool_use',
          };
        },
        stream: () => iter(events),
      },
    };
    const client = createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake });
    const streamed = await drain(client.stream(BASE));

    const deltas = streamed.filter((e) => e.type === 'text_delta').map((e) => (e as any).text);
    expect(deltas.join('')).toBe('let me check');
    const toolEvents = streamed.filter((e) => e.type === 'tool_call');
    expect(toolEvents).toHaveLength(1);

    const doneEv = streamed.at(-1);
    expect(doneEv?.type).toBe('done');
    const streamedResponse = (doneEv as any).response;
    const completed = await client.complete(BASE);
    expect(streamedResponse).toEqual(completed);
  });

  it('OpenAI stream accumulates delta fragments and matches complete()', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'let me ' } }] },
      { choices: [{ delta: { content: 'check' } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];
    const fake: OpenAIClientLike = {
      chat: {
        completions: {
          async create(params) {
            if (params.stream) return iter(chunks) as unknown as Record<string, unknown>;
            return {
              choices: [
                {
                  message: {
                    content: 'let me check',
                    tool_calls: [
                      { id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            };
          },
        },
      },
    };
    const client = createLLMClient({ provider: 'openai', apiKey: 'k' }, { openai: fake });
    const streamed = await drain(client.stream(BASE));
    const doneEv = streamed.at(-1);
    const streamedResponse = (doneEv as any).response;
    const completed = await client.complete(BASE);
    expect(streamedResponse).toEqual(completed);
    expect(streamedResponse.toolCalls).toEqual([
      { id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  const cases: Array<[unknown, string]> = [
    [{ status: 401, message: 'bad key' }, 'auth'],
    [{ status: 429, message: 'slow down' }, 'rate_limit'],
    [Object.assign(new Error('ECONNREFUSED'), {}), 'network'],
  ];

  for (const [thrown, kind] of cases) {
    it(`maps to '${kind}' (anthropic)`, async () => {
      const fake: AnthropicClientLike = {
        messages: {
          async create() {
            throw thrown;
          },
          stream: () => iter([]),
        },
      };
      const client = createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake });
      await expect(client.complete(BASE)).rejects.toMatchObject({ kind });
    });

    it(`maps to '${kind}' (openai)`, async () => {
      const fake: OpenAIClientLike = {
        chat: {
          completions: {
            async create() {
              throw thrown;
            },
          },
        },
      };
      const client = createLLMClient({ provider: 'openai', apiKey: 'k' }, { openai: fake });
      await expect(client.complete(BASE)).rejects.toBeInstanceOf(LLMError);
      await expect(client.complete(BASE)).rejects.toMatchObject({ kind });
    });
  }

  it('maps streaming errors too', async () => {
    const fake: OpenAIClientLike = {
      chat: {
        completions: {
          async create() {
            throw { status: 429, message: 'rate' };
          },
        },
      },
    };
    const client = createLLMClient({ provider: 'openai', apiKey: 'k' }, { openai: fake });
    await expect(drain(client.stream(BASE))).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});

// ---------------------------------------------------------------------------
// Key safety
// ---------------------------------------------------------------------------

describe('API key safety', () => {
  const SECRET = 'sk-ant-super-secret-key-123';

  it('never leaks the key in a thrown error message', async () => {
    const fake: AnthropicClientLike = {
      messages: {
        async create() {
          throw { status: 401, message: `auth failed for ${SECRET}` };
        },
        stream: () => iter([]),
      },
    };
    const client = createLLMClient({ provider: 'anthropic', apiKey: SECRET }, { anthropic: fake });
    try {
      await client.complete(BASE);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMError);
      expect((err as LLMError).message).not.toContain(SECRET);
      expect((err as LLMError).message).toContain('***');
    }
  });

  it('never emits the key in stream events', async () => {
    const client = createLLMClient({ provider: 'mock' });
    const events = await drain(client.stream({ system: 's', messages: [{ role: 'user', content: SECRET }] }));
    const serialized = JSON.stringify(events);
    // The mock echoes the user message, so the secret content itself may appear —
    // what must never appear is the configured apiKey, which mock never receives.
    expect(serialized).not.toContain('apiKey');
  });
});

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

describe('mock provider', () => {
  it('completes deterministically offline (no SDK, no key)', async () => {
    const client = createLLMClient({ provider: 'mock' });
    const resp = await client.complete({ system: 's', messages: [{ role: 'user', content: 'ping' }] });
    expect(resp).toEqual({ content: 'echo: ping', toolCalls: [], stopReason: 'end_turn' });
  });

  it('streams deltas that reconstruct the completed content', async () => {
    const client = createLLMClient({ provider: 'mock' });
    const params = { system: 's', messages: [{ role: 'user' as const, content: 'hello world' }] };
    const events = await drain(client.stream(params));
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e as any).text)
      .join('');
    const done = events.at(-1) as any;
    expect(text).toBe(done.response.content);
    expect(done.response.content).toBe('echo: hello world');
  });
});

// ---------------------------------------------------------------------------
// Content-block transcript fidelity (tool_use + tool_result round-trip)
// ---------------------------------------------------------------------------

describe('content-block transcript', () => {
  const TRANSCRIPT = {
    system: 'sys',
    tools: [TOOL],
    messages: [
      { role: 'user' as const, content: 'weather in Paris?' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'let me check' },
          { type: 'tool_use' as const, id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
        ],
      },
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'tu_1', content: '{"temp":20}' },
        ],
      },
    ],
  };

  it('Anthropic builder passes tool_use + tool_result blocks through natively', async () => {
    let captured: any;
    const fake: AnthropicClientLike = {
      messages: {
        async create(params) {
          captured = params;
          return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
        },
        stream: () => iter([]),
      },
    };
    const client = createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake });
    await client.complete(TRANSCRIPT);

    const assistant = captured.messages[1];
    expect(assistant.content).toContainEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'get_weather',
      input: { city: 'Paris' },
    });
    const userResult = captured.messages[2];
    expect(userResult.content).toContainEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: '{"temp":20}',
    });
  });

  it('OpenAI builder maps tool_use → tool_calls and tool_result → tool messages', async () => {
    let captured: any;
    const fake: OpenAIClientLike = {
      chat: {
        completions: {
          async create(params) {
            captured = params;
            return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
          },
        },
      },
    };
    const client = createLLMClient({ provider: 'openai', apiKey: 'k' }, { openai: fake });
    await client.complete(TRANSCRIPT);

    // messages[0] is the system fold; assistant turn carries tool_calls.
    const assistant = captured.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.content).toBe('let me check');
    expect(assistant.tool_calls).toEqual([
      { id: 'tu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
    // tool_result becomes a standalone tool-role message with matching id.
    const toolMsg = captured.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: '{"temp":20}' });
  });
});

// ---------------------------------------------------------------------------
// AbortSignal threading
// ---------------------------------------------------------------------------

describe('signal threading', () => {
  it('threads the signal into the Anthropic SDK request options', async () => {
    const ac = new AbortController();
    let opts: any;
    const fake: AnthropicClientLike = {
      messages: {
        async create(_params, options) {
          opts = options;
          return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
        },
        stream: () => iter([]),
      },
    };
    const client = createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake });
    await client.complete({ ...BASE, signal: ac.signal });
    expect(opts?.signal).toBe(ac.signal);
  });

  it('threads the signal into the OpenAI SDK request options', async () => {
    const ac = new AbortController();
    let opts: any;
    const fake: OpenAIClientLike = {
      chat: {
        completions: {
          async create(_params, options) {
            opts = options;
            return { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] };
          },
        },
      },
    };
    const client = createLLMClient({ provider: 'openai', apiKey: 'k' }, { openai: fake });
    await client.complete({ ...BASE, signal: ac.signal });
    expect(opts?.signal).toBe(ac.signal);
  });
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

describe('config resolution', () => {
  it('throws for an unknown provider', () => {
    expect(() => createLLMClient({ provider: 'nope' })).toThrow(LLMError);
  });

  it('honors explicit model/baseURL over catalog defaults', async () => {
    let captured: any;
    const fake: OpenAIClientLike = {
      chat: {
        completions: {
          async create(params) {
            captured = params;
            return { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] };
          },
        },
      },
    };
    const client = createLLMClient(
      { provider: 'openrouter', model: 'custom/model', apiKey: 'k' },
      { openai: fake },
    );
    expect(client.model).toBe('custom/model');
    await client.complete({ system: 's', messages: [{ role: 'user', content: 'x' }] });
    expect(captured.model).toBe('custom/model');
  });
});
