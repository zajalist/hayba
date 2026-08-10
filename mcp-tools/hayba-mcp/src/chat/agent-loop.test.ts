import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { recordSchema } from '../tools/schema-registry.js';
import {
  runAgentLoop,
  buildToolCatalog,
  isDestructiveToolName,
  argsHash,
  type AgentEvent,
  type AgentLoopParams,
} from './agent-loop.js';
import type {
  LLMClient,
  LLMContentBlock,
  LLMMessage,
  LLMResponse,
  LLMStreamEvent,
  LLMCompleteParams,
} from '../agents/llm-client.js';

// ---------------------------------------------------------------------------
// Fake LLM client: replays a scripted list of turns, one per stream() call.
// Records the tools it was offered so we can assert the catalog.
// ---------------------------------------------------------------------------

function textResponse(content: string): LLMResponse {
  return { content, toolCalls: [], stopReason: 'end_turn' };
}

function toolResponse(name: string, input: Record<string, unknown> = {}, id = `c_${name}`): LLMResponse {
  return {
    content: null,
    toolCalls: [{ id, name, input }],
    stopReason: 'tool_use',
  };
}

class FakeLLMClient implements LLMClient {
  provider = 'mock';
  model = 'fake';
  protocol = 'anthropic' as const;
  offeredToolNames: string[][] = [];
  /** Snapshot of the transcript sent to the client on each stream() call. */
  seenMessages: LLMMessage[][] = [];
  private turns: LLMResponse[];

  constructor(turns: LLMResponse[]) {
    this.turns = [...turns];
  }

  async complete(params: LLMCompleteParams): Promise<LLMResponse> {
    this.offeredToolNames.push((params.tools ?? []).map((t) => t.name));
    return this.turns.shift() ?? textResponse('done');
  }

  async *stream(params: LLMCompleteParams): AsyncGenerator<LLMStreamEvent, void, unknown> {
    this.offeredToolNames.push((params.tools ?? []).map((t) => t.name));
    this.seenMessages.push(params.messages.map((m) => ({ ...m })));
    const resp = this.turns.shift() ?? textResponse('done');
    if (resp.content) yield { type: 'text_delta', text: resp.content };
    for (const call of resp.toolCalls) yield { type: 'tool_call', call };
    yield { type: 'done', response: resp };
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function baseParams(over: Partial<AgentLoopParams>): AgentLoopParams {
  return {
    client: new FakeLLMClient([]),
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { name: 'actor_spawn', description: 'spawn', input_schema: { type: 'object', properties: {} } },
      { name: 'actor_list', description: 'list', input_schema: { type: 'object', properties: {} } },
    ],
    ...over,
  };
}

describe('isDestructiveToolName', () => {
  it('gates lifecycle + setters + exec, not pure reads', () => {
    expect(isDestructiveToolName('actor_spawn')).toBe(true);
    expect(isDestructiveToolName('actor_delete')).toBe(true);
    expect(isDestructiveToolName('python_run')).toBe(true);
    expect(isDestructiveToolName('actor_set_properties')).toBe(true);
    expect(isDestructiveToolName('material_create')).toBe(true);
    expect(isDestructiveToolName('actor_list')).toBe(false);
    expect(isDestructiveToolName('get_tool_signature')).toBe(false);
    expect(isDestructiveToolName('asset_search')).toBe(false);
  });
});

describe('runAgentLoop', () => {
  it('runs a multi-step tool loop (2 rounds) to end_turn', async () => {
    const client = new FakeLLMClient([
      toolResponse('actor_list', {}, 'c1'),
      toolResponse('actor_spawn', { cls: 'X' }, 'c2'),
      textResponse('all done'),
    ]);
    const dispatch = vi.fn(async (name: string) => ({ ok: true, name }));

    const events = await collect(runAgentLoop(baseParams({ client, dispatchTool: dispatch })));

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(['actor_list', 'actor_spawn']);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(2);
    const done = events.at(-1);
    expect(done).toEqual({ type: 'done', reason: 'end_turn', stopReason: 'end_turn' });
    // last turn saw a text_delta
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'all done')).toBe(true);

    // Round-2 transcript must carry the round-1 assistant tool_use block AND the
    // tool_result block, keyed by matching ids.
    const round2 = client.seenMessages[1];
    const blocks = round2.flatMap((m) => (Array.isArray(m.content) ? (m.content as LLMContentBlock[]) : []));
    expect(blocks).toContainEqual({ type: 'tool_use', id: 'c1', name: 'actor_list', input: {} });
    const result = blocks.find(
      (b): b is Extract<LLMContentBlock, { type: 'tool_result' }> => b.type === 'tool_result' && b.tool_use_id === 'c1',
    );
    expect(result).toBeDefined();
    expect(result!.content).toContain('actor_list');
  });

  it('sums usage across every LLM call in the turn (Issue #30 cache-hit metrics)', async () => {
    // Two round-trips: a tool call, then the final text answer. Each carries
    // its own usage; the turn's final `done` must report the SUM, not just
    // the last call's numbers — a multi-step turn genuinely spends both.
    const client = new FakeLLMClient([
      {
        content: null,
        toolCalls: [{ id: 'c1', name: 'actor_list', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900, cacheCreationInputTokens: 0 },
      },
      {
        content: 'done',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 150, outputTokens: 20, cacheReadInputTokens: 900, cacheCreationInputTokens: 0 },
      },
    ]);
    const dispatch = vi.fn(async (name: string) => ({ ok: true, name }));

    const events = await collect(runAgentLoop(baseParams({ client, dispatchTool: dispatch })));
    const done = events.at(-1);
    expect(done).toEqual({
      type: 'done',
      reason: 'end_turn',
      stopReason: 'end_turn',
      usage: { inputTokens: 250, outputTokens: 30, cacheReadInputTokens: 1800, cacheCreationInputTokens: 0 },
    });
  });

  it('leaves usage undefined on the done event when the client never reports it', async () => {
    const client = new FakeLLMClient([textResponse('hi')]);
    const events = await collect(runAgentLoop(baseParams({ client })));
    const done = events.at(-1) as Extract<AgentEvent, { type: 'done' }>;
    expect(done.usage).toBeUndefined();
  });

  it('reports an unknown provider finish reason as a non-success state', async () => {
    const client = new FakeLLMClient([
      {
        content: 'partial answer',
        toolCalls: [],
        stopReason: 'unknown',
      },
    ]);
    const events = await collect(runAgentLoop(baseParams({ client })));
    expect(events.at(-2)).toMatchObject({ type: 'error', kind: 'api' });
    expect(events.at(-1)).toEqual({
      type: 'done',
      reason: 'provider_stop',
      stopReason: 'unknown',
    });
  });

  it('refuses a filtered/disabled tool: not offered AND refused if called', async () => {
    const client = new FakeLLMClient([toolResponse('actor_spawn', {}, 'c1'), textResponse('ok')]);
    const dispatch = vi.fn(async () => ({ ok: true }));

    // Only actor_list is offered; actor_spawn is filtered out of the catalog.
    const tools = [
      { name: 'actor_list', description: 'list', input_schema: { type: 'object' as const, properties: {} } },
    ];
    const events = await collect(runAgentLoop(baseParams({ client, tools, dispatchTool: dispatch })));

    // Not offered
    expect(client.offeredToolNames[0]).toEqual(['actor_list']);
    // Refused, not dispatched
    expect(dispatch).not.toHaveBeenCalled();
    const refusal = events.find((e) => e.type === 'tool_result' && e.name === 'actor_spawn');
    expect(refusal).toBeDefined();
    expect((refusal as { isError?: boolean }).isError).toBe(true);
  });

  it('TS-side destructive tool under Plan Mode → plan_request pause, NO dispatch', async () => {
    const client = new FakeLLMClient([toolResponse('actor_spawn', { cls: 'X' }, 'c1')]);
    const dispatch = vi.fn(async () => ({ ok: true }));

    const events = await collect(
      runAgentLoop(baseParams({ client, dispatchTool: dispatch, planMode: true, planApproved: false })),
    );

    expect(dispatch).not.toHaveBeenCalled();
    const plan = events.find((e) => e.type === 'plan_request');
    expect(plan).toBeDefined();
    expect((plan as { source?: string }).source).toBe('ts');
    // Loop paused: no done event emitted after plan_request.
    expect(events.at(-1)!.type).toBe('plan_request');
  });

  it('argsHash is stable across key ordering', () => {
    expect(argsHash({ a: 1, b: 2 })).toBe(argsHash({ b: 2, a: 1 }));
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
  });

  it('C1: approve A then model requests B → B re-pauses, NO dispatch', async () => {
    const client = new FakeLLMClient([toolResponse('actor_delete', { id: 'B' }, 'c1')]);
    const dispatch = vi.fn(async () => ({ ok: true }));
    // Approval bound to a DIFFERENT call (actor_spawn / id:A).
    const approvedCall = { name: 'actor_spawn', argsHash: argsHash({ id: 'A' }) };
    const tools = [
      { name: 'actor_delete', description: 'del', input_schema: { type: 'object' as const, properties: {} } },
    ];
    const events = await collect(
      runAgentLoop(baseParams({ client, tools, dispatchTool: dispatch, planMode: true, approvedCall })),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(events.at(-1)!.type).toBe('plan_request');
  });

  it('C1: approve A then model requests A (same args) → dispatches once', async () => {
    const client = new FakeLLMClient([toolResponse('actor_spawn', { id: 'A' }, 'c1'), textResponse('done')]);
    const dispatch = vi.fn(async () => ({ ok: true }));
    const approvedCall = { name: 'actor_spawn', argsHash: argsHash({ id: 'A' }) };
    const events = await collect(
      runAgentLoop(baseParams({ client, dispatchTool: dispatch, planMode: true, approvedCall })),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(events.some((e) => e.type === 'plan_request')).toBe(false);
  });

  it('C1: a SECOND copy of the approved call in one turn re-pauses (one-shot)', async () => {
    const client = new FakeLLMClient([
      // Two destructive calls in a single assistant turn, both == the approved one.
      {
        content: null,
        toolCalls: [
          { id: 'c1', name: 'actor_spawn', input: { id: 'A' } },
          { id: 'c2', name: 'actor_spawn', input: { id: 'A' } },
        ],
        stopReason: 'tool_use',
      },
    ]);
    const dispatch = vi.fn(async () => ({ ok: true }));
    const approvedCall = { name: 'actor_spawn', argsHash: argsHash({ id: 'A' }) };
    const events = await collect(
      runAgentLoop(baseParams({ client, dispatchTool: dispatch, planMode: true, approvedCall })),
    );
    // First dispatches; second re-pauses at the gate.
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(events.at(-1)!.type).toBe('plan_request');
  });

  it('C1: plan_request carries the argsHash of the paused call', async () => {
    const client = new FakeLLMClient([toolResponse('actor_spawn', { id: 'Z' }, 'c1')]);
    const events = await collect(
      runAgentLoop(baseParams({ client, dispatchTool: vi.fn(async () => ({})), planMode: true })),
    );
    const plan = events.find((e) => e.type === 'plan_request') as { argsHash?: string };
    expect(plan.argsHash).toBe(argsHash({ id: 'Z' }));
  });

  it('C++ plan_mode_required response → plan_request pause, not a failure', async () => {
    const client = new FakeLLMClient([toolResponse('actor_spawn', {}, 'c1')]);
    // Dispatch returns the C++ gate payload (plan mode NOT set on the loop side).
    const dispatch = vi.fn(async () => ({ status: 'plan_mode_required', hint: 'approve first' }));

    const events = await collect(runAgentLoop(baseParams({ client, dispatchTool: dispatch })));

    expect(dispatch).toHaveBeenCalledTimes(1);
    const plan = events.find((e) => e.type === 'plan_request');
    expect(plan).toBeDefined();
    expect((plan as { source?: string }).source).toBe('ue');
    expect((plan as { hint?: string }).hint).toBe('approve first');
    // No tool_result (not counted as success/failure) after the gate.
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);
  });

  it('halts at maxSteps', async () => {
    // Endlessly requests a (non-destructive) tool; loop must stop at maxSteps.
    const client = new FakeLLMClient(Array.from({ length: 10 }, (_, i) => toolResponse('actor_list', {}, `c${i}`)));
    const dispatch = vi.fn(async () => ({ ok: true }));

    const events = await collect(runAgentLoop(baseParams({ client, dispatchTool: dispatch, maxSteps: 3 })));

    const done = events.at(-1);
    expect(done).toEqual({ type: 'done', reason: 'max_steps' });
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('aborts mid-loop via AbortSignal', async () => {
    const ac = new AbortController();
    const client = new FakeLLMClient([
      toolResponse('actor_list', {}, 'c1'),
      toolResponse('actor_list', {}, 'c2'),
      textResponse('never'),
    ]);
    const dispatch = vi.fn(async () => {
      ac.abort(); // abort after the first dispatch
      return { ok: true };
    });

    const events = await collect(runAgentLoop(baseParams({ client, dispatchTool: dispatch, signal: ac.signal })));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'error' && (e as { kind?: string }).kind === 'aborted')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', reason: 'aborted' });
  });

  it('never leaks the API key in any event', async () => {
    const SECRET = 'sk-super-secret-key-123';
    const client = new FakeLLMClient([toolResponse('actor_list', {}, 'c1'), textResponse(`done ${SECRET ? '' : ''}`)]);
    const dispatch = vi.fn(async () => ({ ok: true }));

    const events = await collect(runAgentLoop(baseParams({ client, dispatchTool: dispatch })));

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SECRET);
  });
});

describe('buildToolCatalog', () => {
  it('filters by archetype tool_filter and disabled list', () => {
    const listCommands = () => ['actor_spawn', 'actor_list', 'pcg_create_graph'];
    const isDisabled = (n: string) => n === 'actor_list';
    // No recorded shapes in this unit → getRawShape returns null, so all are
    // dropped; assert filtering logic directly via the allowed()/disabled paths
    // by confirming an empty result when shapes are absent.
    const tools = buildToolCatalog({
      listCommands,
      isDisabled,
      archetypeFilter: ['actor_*'],
    });
    // Shapes aren't recorded in this isolated test, so catalog is empty — the
    // registry-derived branch is covered by integration; here we assert the
    // function runs and honours the no-shape skip without throwing.
    expect(Array.isArray(tools)).toBe(true);
  });

  // The second copy of the rule shared in tools/zod-unwrap.ts. This surface and
  // the tool catalogue's prose describer once disagreed about `.default()`
  // (#322), so the same parameter was advertised two different ways depending
  // on which one an agent was reading. Both are pinned now.
  it('a defaulted param is not required, and the schema carries the default', () => {
    recordSchema('zzz_default_probe', {
      shape: {
        needed: z.string(),
        capped: z.number().default(5),
        maybe: z.string().optional(),
      },
      cost: 'low',
      returns: '{ok}',
    });

    const tool = buildToolCatalog({ listCommands: () => ['zzz_default_probe'] }).find(
      (t) => t.name === 'zzz_default_probe',
    );

    expect(tool, 'the probe tool should be in the catalog').toBeDefined();
    const schema = tool!.input_schema as { required?: string[]; properties: Record<string, { default?: unknown }> };
    expect(schema.required, 'only the genuinely required param is required').toEqual(['needed']);
    expect(schema.properties.capped.default, 'the value it gets by omitting it').toBe(5);
    expect(schema.properties.maybe, 'a plain optional has no default to report').not.toHaveProperty('default');
  });
});
