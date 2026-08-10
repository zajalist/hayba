import { describe, it, expect, vi } from 'vitest';
import {
  createLLMClient,
  buildAnthropicRequest,
  type AnthropicClientLike,
  type LLMCompleteParams,
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

const RESOLVED_CFG = { provider: 'anthropic', protocol: 'anthropic' as const, model: 'claude-x', baseURL: '', apiKey: 'k' };

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
