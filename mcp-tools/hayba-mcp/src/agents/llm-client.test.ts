import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import {
  createLLMClient,
  buildAnthropicRequest,
  LLMError,
  type AnthropicClientLike,
  type LLMCompleteParams,
  type LLMStreamEvent,
  type LLMTool,
} from './llm-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tool(name: string): LLMTool {
  return { name, description: `does ${name}`, input_schema: { type: 'object', properties: {} } };
}

function baseParams(over: Partial<LLMCompleteParams> = {}): LLMCompleteParams {
  return {
    system: 'You are the Hayba copilot.',
    messages: [{ role: 'user', content: 'hi' }],
    ...over,
  };
}

const RESOLVED_CFG = {
  provider: 'anthropic',
  protocol: 'anthropic' as const,
  model: 'claude-x',
  baseURL: '',
  apiKey: 'k',
};

function anthropicFake(over: Partial<AnthropicClientLike['messages']> = {}): AnthropicClientLike {
  return {
    messages: {
      create: vi.fn(),
      stream: vi.fn(),
      ...over,
    },
  };
}

async function collectStream(client: ReturnType<typeof createLLMClient>): Promise<LLMStreamEvent[]> {
  const events: LLMStreamEvent[] = [];
  for await (const event of client.stream(baseParams())) events.push(event);
  return events;
}

// ---------------------------------------------------------------------------
// cache_control placement (Issue #30)
// ---------------------------------------------------------------------------

describe('buildAnthropicRequest — cache_control placement', () => {
  it('marks the system block with cache_control:ephemeral', () => {
    const req = buildAnthropicRequest(RESOLVED_CFG, baseParams({ tools: [tool('actor_spawn')] }));
    expect(req.system).toEqual([
      { type: 'text', text: 'You are the Hayba copilot.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('marks only the LAST tool in the catalog, not every tool', () => {
    const tools = [tool('actor_spawn'), tool('actor_list'), tool('actor_delete')];
    const req = buildAnthropicRequest(RESOLVED_CFG, baseParams({ tools }));
    const reqTools = req.tools as Array<Record<string, unknown>>;
    expect(reqTools).toHaveLength(3);
    expect(reqTools[0].cache_control).toBeUndefined();
    expect(reqTools[1].cache_control).toBeUndefined();
    expect(reqTools[2].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('never marks messages — the volatile, per-turn-growing block', () => {
    const req = buildAnthropicRequest(
      RESOLVED_CFG,
      baseParams({
        tools: [tool('actor_spawn')],
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: [{ type: 'text', text: 'do a thing' }] },
        ],
      }),
    );
    const msgs = req.messages as Array<{ content: unknown }>;
    for (const m of msgs) {
      const content = m.content;
      if (typeof content === 'string') continue; // plain string can't carry cache_control anyway
      for (const block of content as Array<Record<string, unknown>>) {
        expect(block.cache_control).toBeUndefined();
      }
    }
  });

  it('keeps the breakpoint count fixed (2: system + tools-tail) regardless of catalog size', () => {
    const manyTools = Array.from({ length: 60 }, (_, i) => tool(`tool_${i}`));
    const req = buildAnthropicRequest(RESOLVED_CFG, baseParams({ tools: manyTools }));
    const reqTools = req.tools as Array<Record<string, unknown>>;
    const toolBreakpoints = reqTools.filter((t) => t.cache_control !== undefined).length;
    const systemBreakpoints = (req.system as Array<Record<string, unknown>>).filter(
      (b) => b.cache_control !== undefined,
    ).length;
    expect(toolBreakpoints).toBe(1);
    expect(systemBreakpoints).toBe(1);
    // Anthropic's hard cap is 4 breakpoints per request.
    expect(toolBreakpoints + systemBreakpoints).toBeLessThanOrEqual(4);
  });

  it('omits tools entirely when none are offered — no stray cache_control on an empty list', () => {
    const req = buildAnthropicRequest(RESOLVED_CFG, baseParams());
    expect(req.tools).toBeUndefined();
    // System is still cacheable even with no tools.
    expect((req.system as Array<Record<string, unknown>>)[0].cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  it('does not crash and emits a plain string system when system is empty (harmless no-op)', () => {
    const req = buildAnthropicRequest(RESOLVED_CFG, baseParams({ system: '' }));
    expect(req.system).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Anthropic 0.115 stop/content compatibility (Issue #398)
// ---------------------------------------------------------------------------

describe('Anthropic 0.115 non-stream responses', () => {
  it.each([
    ['end_turn', 'end_turn'],
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'model_context_window_exceeded'],
  ] as const)('keeps %s distinct instead of collapsing it to success', async (wireReason, expected) => {
    const fake = anthropicFake({
      create: vi.fn().mockResolvedValue({ content: [], stop_reason: wireReason }),
    });
    const response = await createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake }).complete(
      baseParams(),
    );
    expect(response.stopReason).toBe(expected);
  });

  it('parses a complete tool_use block as a structured call', async () => {
    const fake = anthropicFake({
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'tool_use', id: 'tool_1', name: 'actor_list', input: { class: 'Pawn' } }],
        stop_reason: 'tool_use',
      }),
    });
    const response = await createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake }).complete(
      baseParams(),
    );
    expect(response).toMatchObject({
      stopReason: 'tool_use',
      toolCalls: [{ id: 'tool_1', name: 'actor_list', input: { class: 'Pawn' } }],
    });
  });

  it('maps an unknown future stop reason to unknown with bounded guidance', async () => {
    const futureReason = `future_${'x'.repeat(5000)}`;
    const fake = anthropicFake({
      create: vi.fn().mockResolvedValue({ content: [], stop_reason: futureReason }),
    });
    const response = await createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake }).complete(
      baseParams(),
    );
    expect(response.stopReason).toBe('unknown');
    expect(response.stopDiagnostic?.code).toBe('unknown_stop_reason');
    expect(JSON.stringify(response.stopDiagnostic)).not.toContain(futureReason);
    expect(JSON.stringify(response.stopDiagnostic).length).toBeLessThan(320);
  });

  it('gives context exhaustion a bounded recovery tip without provider or prompt text', async () => {
    const secret = 'sk-ant-context-secret';
    const fake = anthropicFake({
      create: vi.fn().mockResolvedValue({
        content: [],
        stop_reason: 'model_context_window_exceeded',
        stop_details: { explanation: `repeat prompt and ${secret}` },
      }),
    });
    const response = await createLLMClient({ provider: 'anthropic', apiKey: secret }, { anthropic: fake }).complete(
      baseParams({ messages: [{ role: 'user', content: `private prompt ${secret}` }] }),
    );
    expect(response.stopDiagnostic).toMatchObject({
      code: 'context_window_exceeded',
      recoveryTip: expect.stringContaining('remove older messages'),
    });
    const serialized = JSON.stringify(response.stopDiagnostic);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('private prompt');
    expect(serialized.length).toBeLessThan(320);
  });

  it('handles refusal stop details without echoing the provider explanation', async () => {
    const secret = 'sk-ant-refusal-secret';
    const fake = anthropicFake({
      create: vi.fn().mockResolvedValue({
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: `provider repeated ${secret}` },
      }),
    });
    const response = await createLLMClient({ provider: 'anthropic', apiKey: secret }, { anthropic: fake }).complete(
      baseParams(),
    );
    expect(response).toMatchObject({
      stopReason: 'refusal',
      stopDiagnostic: { code: 'provider_refusal', message: expect.stringContaining('cyber') },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(response)).not.toContain('provider repeated');
  });

  it.each(['tool_addition', 'tool_removal'])(
    'rejects unsupported %s blocks explicitly instead of discarding catalog state',
    async (type) => {
      const fake = anthropicFake({
        create: vi.fn().mockResolvedValue({
          content: [{ type, tool: { type: 'tool_reference', name: 'actor_spawn' } }],
          stop_reason: 'end_turn',
        }),
      });
      await expect(
        createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fake }).complete(baseParams()),
      ).rejects.toMatchObject({ kind: 'protocol', message: expect.stringContaining(type) });
    },
  );

  it('rejects error content without reflecting its untrusted payload', async () => {
    const secret = 'sk-ant-block-secret';
    const fake = anthropicFake({
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'error', message: `wire payload ${secret}` }],
        stop_reason: 'end_turn',
      }),
    });
    const promise = createLLMClient({ provider: 'anthropic', apiKey: secret }, { anthropic: fake }).complete(
      baseParams(),
    );
    await expect(promise).rejects.toMatchObject({ kind: 'protocol' });
    await expect(promise).rejects.not.toThrow(secret);
  });
});

describe('Anthropic 0.115 stream events', () => {
  function streamThrough(...events: unknown[]): ReturnType<typeof createLLMClient> {
    async function* fixture() {
      for (const event of events) yield event;
    }
    return createLLMClient(
      { provider: 'anthropic', apiKey: 'k' },
      { anthropic: anthropicFake({ stream: vi.fn().mockReturnValue(fixture()) }) },
    );
  }

  it.each([
    ['end_turn', 'end_turn'],
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'model_context_window_exceeded'],
    ['future_stop', 'unknown'],
  ] as const)('keeps streamed %s as %s', async (wireReason, expected) => {
    const events = await collectStream(
      streamThrough(
        { type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'message_delta', delta: { stop_reason: wireReason }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ),
    );
    const done = events.at(-1) as Extract<LLMStreamEvent, { type: 'done' }>;
    expect(done.response.stopReason).toBe(expected);
    expect(done.response.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
  });

  it('assembles a streamed tool call from partial JSON', async () => {
    const events = await collectStream(
      streamThrough(
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tool_2', name: 'actor_list' },
        },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"class":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Pawn"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ),
    );
    expect(events).toContainEqual({
      type: 'tool_call',
      call: { id: 'tool_2', name: 'actor_list', input: { class: 'Pawn' } },
    });
    expect((events.at(-1) as Extract<LLMStreamEvent, { type: 'done' }>).response.stopReason).toBe('tool_use');
  });

  it('rejects malformed partial tool JSON as a protocol error without echoing it', async () => {
    const client = streamThrough(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool_bad', name: 'actor_spawn' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"secret":"DO_NOT_ECHO"' },
      },
      { type: 'content_block_stop', index: 0 },
    );
    const error = await collectStream(client).catch((caught: unknown) => caught as LLMError);
    expect(error).toMatchObject({
      kind: 'protocol',
      message: expect.stringContaining('malformed tool input JSON'),
    });
    expect((error as LLMError).message).not.toContain('DO_NOT_ECHO');
  });

  it.each(['tool_addition', 'tool_removal'])(
    'rejects streamed %s content blocks instead of discarding catalog state',
    async (type) => {
      await expect(
        collectStream(
          streamThrough({
            type: 'content_block_start',
            index: 0,
            content_block: { type, tool: { type: 'tool_reference', name: 'actor_spawn' } },
          }),
        ),
      ).rejects.toMatchObject({ kind: 'protocol', message: expect.stringContaining(type) });
    },
  );

  it('rejects a streamed tool_change event explicitly', async () => {
    await expect(
      collectStream(streamThrough({ type: 'tool_change', tool: { type: 'tool_reference', name: 'actor_spawn' } })),
    ).rejects.toMatchObject({ kind: 'protocol', message: expect.stringContaining('tool_change') });
  });

  it('normalizes a streamed refusal without reflecting its explanation', async () => {
    const secret = 'streamed-refusal-secret';
    const events = await collectStream(
      streamThrough(
        {
          type: 'message_delta',
          delta: {
            stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: `provider repeated ${secret}` },
          },
        },
        { type: 'message_stop' },
      ),
    );
    const done = events.at(-1) as Extract<LLMStreamEvent, { type: 'done' }>;
    expect(done.response).toMatchObject({
      stopReason: 'refusal',
      stopDiagnostic: { code: 'provider_refusal', message: expect.stringContaining('cyber') },
    });
    expect(JSON.stringify(done.response)).not.toContain(secret);
    expect(JSON.stringify(done.response)).not.toContain('provider repeated');
  });

  it('redacts a provider stream error and preserves its API classification', async () => {
    const secret = 'sk-ant-stream-secret';
    async function* fixture() {
      yield { type: 'error', error: { type: 'overloaded_error', message: `upstream exposed ${secret}` } };
    }
    const client = createLLMClient(
      { provider: 'anthropic', apiKey: secret },
      { anthropic: anthropicFake({ stream: vi.fn().mockReturnValue(fixture()) }) },
    );
    const error = await collectStream(client).catch((caught: unknown) => caught as LLMError);
    expect(error).toMatchObject({ kind: 'api' });
    expect((error as LLMError).message).toContain('[REDACTED:api_key]');
    expect((error as LLMError).message).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// Usage / cache-hit metrics
// ---------------------------------------------------------------------------

describe('cache-hit usage metrics', () => {
  it('complete() surfaces cache_creation_input_tokens / cache_read_input_tokens from usage', async () => {
    const fakeAnthropic: AnthropicClientLike = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 120,
            output_tokens: 12,
            cache_creation_input_tokens: 400,
            cache_read_input_tokens: 3000,
          },
        }),
        stream: vi.fn(),
      },
    };
    const client = createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fakeAnthropic });
    const resp = await client.complete(baseParams());
    expect(resp.usage).toEqual({
      inputTokens: 120,
      outputTokens: 12,
      cacheCreationInputTokens: 400,
      cacheReadInputTokens: 3000,
    });
  });

  it('stream() merges usage from message_start (cache fields) and message_delta (output tokens)', async () => {
    async function* fakeStream() {
      yield {
        type: 'message_start',
        message: {
          usage: { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0 },
        },
      };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } };
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } };
    }
    const fakeAnthropic: AnthropicClientLike = {
      messages: { create: vi.fn(), stream: vi.fn().mockReturnValue(fakeStream()) },
    };
    const client = createLLMClient({ provider: 'anthropic', apiKey: 'k' }, { anthropic: fakeAnthropic });

    let doneUsage: unknown;
    for await (const ev of client.stream(baseParams())) {
      if (ev.type === 'done') doneUsage = ev.response.usage;
    }
    expect(doneUsage).toEqual({
      inputTokens: 500,
      outputTokens: 7,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 2500,
    });
  });

  it('leaves usage undefined when the wire payload has no usage field (mock protocol, e.g.)', async () => {
    const client = createLLMClient({ provider: 'mock' });
    const resp = await client.complete(baseParams());
    expect(resp.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Transport invariants retained across the SDK upgrade
// ---------------------------------------------------------------------------

describe('Anthropic request/error invariants', () => {
  it('threads the same AbortSignal through complete() and stream()', async () => {
    const controller = new AbortController();
    const create = vi.fn().mockResolvedValue({ content: [], stop_reason: 'end_turn' });
    async function* fixture() {
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } };
      yield { type: 'message_stop' };
    }
    const stream = vi.fn().mockReturnValue(fixture());
    const client = createLLMClient(
      { provider: 'anthropic', apiKey: 'k' },
      { anthropic: anthropicFake({ create, stream }) },
    );

    await client.complete(baseParams({ signal: controller.signal }));
    const streamed: LLMStreamEvent[] = [];
    for await (const event of client.stream(baseParams({ signal: controller.signal }))) streamed.push(event);
    expect(streamed.at(-1)?.type).toBe('done');

    expect(create.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
    expect(stream.mock.calls[0]?.[1]).toEqual({ signal: controller.signal });
  });

  it('keeps AbortError distinct from an ordinary network failure', async () => {
    async function* fixture() {
      yield { type: 'message_stop' };
      const error = new Error('request aborted');
      error.name = 'AbortError';
      throw error;
    }
    const client = createLLMClient(
      { provider: 'anthropic', apiKey: 'k' },
      { anthropic: anthropicFake({ stream: vi.fn().mockReturnValue(fixture()) }) },
    );
    await expect(collectStream(client)).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('redacts the configured key from a provider HTTP error', async () => {
    const secret = 'sk-ant-provider-secret';
    const create = vi.fn().mockRejectedValue({ status: 401, message: `bad bearer ${secret}` });
    const promise = createLLMClient(
      { provider: 'anthropic', apiKey: secret },
      { anthropic: anthropicFake({ create }) },
    ).complete(baseParams());
    const error = await promise.catch((caught: unknown) => caught as LLMError);
    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    expect((error as LLMError).message).toContain('***');
    expect((error as LLMError).message).not.toContain(secret);
  });

  it('constructs the real 0.115 module lazily against localhost with no external API key', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'msg_local_fixture',
          type: 'message',
          role: 'assistant',
          model: 'claude-local-fixture',
          content: [{ type: 'text', text: 'local module loaded' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 2, output_tokens: 3 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP test listener');

    try {
      const client = createLLMClient({
        provider: 'anthropic',
        apiKey: 'local-fixture-key',
        baseURL: `http://127.0.0.1:${address.port}`,
      });
      expect(requests, 'construction must not perform I/O').toBe(0);
      const response = await client.complete(baseParams());
      expect(requests).toBe(1);
      expect(response).toMatchObject({
        content: 'local module loaded',
        stopReason: 'end_turn',
        usage: { inputTokens: 2, outputTokens: 3 },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
