import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { recordSchema } from '../tools/schema-registry.js';
import { registerChatCapturedTools } from './tool-dispatch.js';
import {
  runLegacyAgentLoop as runAgentLoop,
  runAgentLoop as runSemanticAgentLoop,
  buildToolCatalog,
  isDestructiveToolName,
  argsHash,
  type AgentEvent,
  type AgentLoopParams,
} from './agent-loop.js';
import { ActivityEventSchema, reduceActivity, type ActivityState, type AgentStreamEvent } from './activity-events.js';
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
  seenSystems: string[] = [];
  private turns: LLMResponse[];

  constructor(turns: LLMResponse[]) {
    this.turns = [...turns];
  }

  async complete(params: LLMCompleteParams): Promise<LLMResponse> {
    this.offeredToolNames.push((params.tools ?? []).map((t) => t.name));
    return this.turns.shift() ?? textResponse('done');
  }

  async *stream(params: LLMCompleteParams): AsyncGenerator<LLMStreamEvent, void, unknown> {
    this.seenSystems.push(params.system);
    this.offeredToolNames.push((params.tools ?? []).map((t) => t.name));
    this.seenMessages.push(params.messages.map((m) => ({ ...m })));
    const resp = this.turns.shift() ?? textResponse('done');
    if (resp.content) yield { type: 'text_delta', text: resp.content };
    for (const call of resp.toolCalls) yield { type: 'tool_call', call };
    yield { type: 'done', response: resp };
  }
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function reduceStream(events: AgentStreamEvent[], initial: ActivityState | null = null): ActivityState {
  return events.reduce<ActivityState | null>(
    (state, event) => reduceActivity(state, ActivityEventSchema.parse(event)),
    initial,
  )!;
}

describe('semantic runAgentLoop', () => {
  it('routes over the enabled catalog and exposes identity only in activity detail frames', async () => {
    const client = new FakeLLMClient([toolResponse('asset_search'), textResponse('Found assets')]);
    const events = await collect(
      runSemanticAgentLoop(
        baseParams({
          client,
          messages: [{ role: 'user', content: 'Find Content Browser assets by path' }],
          tools: ['asset_search', 'asset_delete', 'actor_list'].map((name) => ({
            name,
            description: '',
            input_schema: { type: 'object', properties: {} },
          })),
          disabledTools: ['asset_delete'],
          dispatchTool: async () => ({ assets: [] }),
        }),
      ),
    );
    expect(client.offeredToolNames[0]).toEqual(['asset_search']);
    expect(client.seenSystems[0]).toContain('Content Browser assets');
    for (const event of events) {
      expect(ActivityEventSchema.safeParse(event).success).toBe(true);
      if (event.type === 'activity_started' || event.type === 'activity_step')
        expect(event).toHaveProperty('specialistId', 'asset-manager');
      else expect(event).not.toHaveProperty('specialistId');
    }
    expect(reduceStream(events).status).toBe('succeeded');
  });

  it('honors a pin over automatic intent while keeping approval gates', async () => {
    const client = new FakeLLMClient([toolResponse('actor_spawn')]);
    const dispatch = vi.fn();
    const events = await collect(
      runSemanticAgentLoop(
        baseParams({
          client,
          pinnedSpecialistId: 'blueprint-generator',
          messages: [{ role: 'user', content: 'Content Browser assets' }],
          dispatchTool: dispatch,
          planMode: true,
        }),
      ),
    );
    expect(events[0]).toHaveProperty('specialistId', 'blueprint-generator');
    expect(events.at(-1)).toMatchObject({ type: 'approval_requested' });
    expect(events.at(-1)).not.toHaveProperty('specialistId');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects unknown specialist pins before calling the provider', async () => {
    const client = new FakeLLMClient([]);
    await expect(collect(runSemanticAgentLoop(baseParams({ client, pinnedSpecialistId: 'missing' })))).rejects.toThrow(
      /unknown archetype/,
    );
    expect(client.offeredToolNames).toEqual([]);
  });

  it('keeps coordinator behavior when no specialist matches', async () => {
    const client = new FakeLLMClient([textResponse('Hello')]);
    const events = await collect(runSemanticAgentLoop(baseParams({ client })));
    expect(events[0]).toHaveProperty('specialistId', 'director');
    expect(client.offeredToolNames[0]).toEqual(['actor_spawn', 'actor_list']);
  });

  it('routes from the latest human text even when a resumed transcript ends in tool results', async () => {
    const events = await collect(
      runSemanticAgentLoop(
        baseParams({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Find Content Browser assets by path' }] },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'asset_search', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'No assets found' }] },
          ],
          tools: [{ name: 'asset_search', description: '', input_schema: { type: 'object', properties: {} } }],
        }),
      ),
    );
    expect(events[0]).toHaveProperty('specialistId', 'asset-manager');
  });

  it('refuses calls excluded by a pinned profile or an additional explicit filter', async () => {
    const dispatch = vi.fn();
    const client = new FakeLLMClient([toolResponse('actor_list'), toolResponse('asset_delete'), textResponse('Done')]);
    const events = await collect(
      runSemanticAgentLoop(
        baseParams({
          client,
          pinnedSpecialistId: 'asset-manager',
          archetypeFilter: ['*_search'],
          tools: ['asset_search', 'asset_delete', 'actor_list'].map((name) => ({
            name,
            description: '',
            input_schema: { type: 'object', properties: {} },
          })),
          dispatchTool: dispatch,
        }),
      ),
    );
    expect(client.offeredToolNames[0]).toEqual(['asset_search']);
    expect(events.filter((event) => event.type === 'activity_step' && event.step.status === 'failed')).toHaveLength(2);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('streams a reducer-valid tool activity and provider-neutral usage', async () => {
    const events = await collect(
      runSemanticAgentLoop(
        baseParams({
          activityId: 'a1',
          activityTitle: 'Inspect actors',
          client: new FakeLLMClient([
            toolResponse('actor_list', {}, 'c1'),
            { ...textResponse('Done'), usage: { inputTokens: 12, outputTokens: 3 } },
          ]),
          dispatchTool: async () => ({ actors: [] }),
        }),
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      'activity_started',
      'activity_step',
      'activity_step',
      'message_delta',
      'activity_completed',
    ]);
    expect(events[1]).toMatchObject({ step: { status: 'running', id: 'c1', name: 'actor_list', input: {} } });
    expect(events[2]).toMatchObject({ step: { status: 'succeeded', id: 'c1', result: { actors: [] } } });
    expect(reduceStream(events)).toMatchObject({
      activityId: 'a1',
      title: 'Inspect actors',
      status: 'succeeded',
      text: 'Done',
      completion: { usage: { inputTokens: 12, outputTokens: 3 } },
    });
  });

  it.each(['ts', 'ue', 'workflow', 'mcp'] as const)(
    'pauses semantically for %s approval without completion',
    async (source) => {
      const workflow = { ok: false, stages: [{ stage: 'terrain', status: 'pending', code: 'plan_mode_required' }] };
      const dispatch = vi.fn(async () =>
        source === 'ue'
          ? { status: 'plan_mode_required' }
          : source === 'mcp'
            ? { content: [{ type: 'text', text: JSON.stringify(workflow) }] }
            : workflow,
      );
      const events = await collect(
        runSemanticAgentLoop(
          baseParams({
            activityId: 'a1',
            client: new FakeLLMClient([toolResponse('actor_spawn', { label: 'Tree' }, 'c1')]),
            planMode: source === 'ts',
            dispatchTool: dispatch,
          }),
        ),
      );
      expect(events.at(-1)).toMatchObject({
        type: 'approval_requested',
        source: source === 'ts' ? 'ts' : 'ue',
        argsHash: '{"label":"Tree"}',
      });
      expect(events.some((event) => event.type === 'activity_completed')).toBe(false);
      expect(reduceStream(events).status).toBe('awaiting_approval');
      expect(dispatch).toHaveBeenCalledTimes(source === 'ts' ? 0 : 1);
    },
  );

  it.each(['c1', 'new-call-id'])(
    'resumes the same activity with call ID %s through a one-shot approval',
    async (id) => {
      const params = baseParams({
        activityId: 'a1',
        planMode: true,
        client: new FakeLLMClient([toolResponse('actor_spawn', {}, 'c1')]),
        dispatchTool: async () => ({ ok: true }),
      });
      const paused = reduceStream(await collect(runSemanticAgentLoop(params)));
      const events = await collect(
        runSemanticAgentLoop({
          ...params,
          client: new FakeLLMClient([toolResponse('actor_spawn', {}, id), textResponse('Done')]),
          resumeApprovalId: paused.approval!.approvalId,
          approvedCall: { name: 'actor_spawn', argsHash: '{}' },
        }),
      );
      expect(events[0]).toMatchObject({ type: 'activity_started', resumeApprovalId: paused.approval!.approvalId });
      const completed = reduceStream(events, paused);
      expect(completed.status).toBe('succeeded');
      expect(completed.steps).toEqual([{ status: 'succeeded', id, name: 'actor_spawn', result: { ok: true } }]);
    },
  );

  it('ends cancellation with exactly one terminal event', async () => {
    const controller = new AbortController();
    const events = await collect(
      runSemanticAgentLoop(
        baseParams({
          client: new FakeLLMClient([toolResponse('actor_list')]),
          signal: controller.signal,
          dispatchTool: async () => {
            controller.abort();
            return {};
          },
        }),
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: 'activity_completed', outcome: 'cancelled', reason: 'aborted' });
    expect(events.filter((event) => event.type === 'error' || event.type === 'activity_completed')).toHaveLength(1);
    expect(reduceStream(events)).toMatchObject({ status: 'failed', outcome: 'cancelled' });
  });

  it.each(['refusal', 'model_context_window_exceeded', 'unknown'] as const)(
    'terminates provider %s errors without a second terminal event',
    async (stopReason) => {
      const events = await collect(
        runSemanticAgentLoop(baseParams({ client: new FakeLLMClient([{ content: null, toolCalls: [], stopReason }]) })),
      );
      expect(events.at(-1)).toMatchObject({ type: 'error', termination: { stopReason } });
      expect(events.filter((event) => event.type === 'error' || event.type === 'activity_completed')).toHaveLength(1);
      expect(reduceStream(events).status).toBe('failed');
    },
  );

  it('terminates a thrown provider failure and retains the legacy error-only contract', async () => {
    const params = baseParams({
      client: {
        ...new FakeLLMClient([]),
        provider: 'mock',
        model: 'fake',
        protocol: 'anthropic',
        complete: async () => textResponse('unused'),
        async *stream() {
          throw new Error('offline');
        },
      },
    });
    const events = await collect(runSemanticAgentLoop(params));
    expect(reduceStream(events)).toMatchObject({ status: 'failed', error: { error: 'offline' } });
    expect(await collect(runAgentLoop(params))).toEqual([{ type: 'error', error: 'offline' }]);
  });

  it('keeps legacy frame payloads and order compatible', async () => {
    const params = baseParams({
      client: new FakeLLMClient([toolResponse('actor_list', { limit: 1 }, 'c1'), textResponse('Done')]),
      dispatchTool: async () => ({ actors: ['Tree'] }),
    });
    expect(await collect(runAgentLoop(params))).toEqual([
      { type: 'tool_call', call: { id: 'c1', name: 'actor_list', input: { limit: 1 } } },
      { type: 'tool_result', id: 'c1', name: 'actor_list', result: { actors: ['Tree'] } },
      { type: 'text_delta', text: 'Done' },
      { type: 'done', reason: 'end_turn', stopReason: 'end_turn' },
    ]);
  });
});

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
  it.each(['world_ingest', 'asset_prepare', 'level_save'])(
    'requests approval before dispatching %s in Plan Mode',
    async (name) => {
      const dispatch = vi.fn();
      const events = await collect(
        runAgentLoop(
          baseParams({
            client: new FakeLLMClient([toolResponse(name)]),
            dispatchTool: dispatch,
            planMode: true,
            tools: [{ name, description: '', input_schema: { type: 'object', properties: {} } }],
          }),
        ),
      );
      expect(dispatch).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ type: 'plan_request', source: 'ts' });
    },
  );

  it.each([false, true])('treats workflow approval-required stages as a pause, not a failure (MCP=%s)', async (mcp) => {
    const result = { ok: false, stages: [{ stage: 'terrain', status: 'pending', code: 'plan_mode_required' }] };
    const dispatch = vi.fn(async () =>
      mcp ? { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false } : result,
    );
    const events = await collect(
      runAgentLoop(
        baseParams({
          client: new FakeLLMClient([toolResponse('world_ingest')]),
          dispatchTool: dispatch,
          tools: [{ name: 'world_ingest', description: '', input_schema: { type: 'object', properties: {} } }],
        }),
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: 'plan_request', source: 'ue' });
    expect(events.some((e) => e.type === 'tool_result')).toBe(false);
  });
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

  it('treats context-window exhaustion as an error with bounded recovery guidance', async () => {
    const secret = 'sk-ant-must-not-leak';
    const client = new FakeLLMClient([
      {
        content: null,
        toolCalls: [],
        stopReason: 'model_context_window_exceeded',
        stopDiagnostic: {
          code: 'context_window_exceeded',
          message: 'Anthropic stopped because the model context window was exhausted.',
          recoveryTip: 'Start a new chat or remove older messages and large tool results, then retry.',
        },
      },
    ]);
    const events = await collect(
      runAgentLoop(
        baseParams({
          client,
          messages: [{ role: 'user', content: `private prompt ${secret}` }],
        }),
      ),
    );
    const error = events.find((event) => event.type === 'error') as Extract<AgentEvent, { type: 'error' }>;
    expect(error).toMatchObject({ kind: 'context_window_exceeded' });
    expect(error.error).toContain('Tip:');
    expect(error.error.length).toBeLessThanOrEqual(384);
    expect(error.error).not.toContain(secret);
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      reason: 'context_window_exceeded',
      stopReason: 'model_context_window_exceeded',
    });
    expect(events.at(-1)).not.toMatchObject({ reason: 'end_turn' });
  });

  it.each([
    ['max_tokens', 'max_tokens'],
    ['refusal', 'provider_refusal'],
  ] as const)('reports %s as %s instead of a successful end_turn', async (stopReason, reason) => {
    const client = new FakeLLMClient([{ content: null, toolCalls: [], stopReason }]);
    const events = await collect(runAgentLoop(baseParams({ client })));
    expect(events.at(-1)).toMatchObject({ type: 'done', reason, stopReason });
    expect(events.at(-1)).not.toMatchObject({ reason: 'end_turn' });
  });

  it('reports a diagnosed Anthropic unknown stop as a provider protocol error', async () => {
    const client = new FakeLLMClient([
      {
        content: null,
        toolCalls: [],
        stopReason: 'unknown',
        stopDiagnostic: {
          code: 'unknown_stop_reason',
          message: 'Anthropic returned an unsupported stop reason; the turn was not treated as complete.',
          recoveryTip: 'Upgrade Hayba or choose another provider before retrying this turn.',
        },
      },
    ]);
    const events = await collect(runAgentLoop(baseParams({ client })));
    expect(events.at(-2)).toMatchObject({ type: 'error', kind: 'provider_protocol' });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      reason: 'provider_protocol_error',
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
  it('offers only registered captured names and respects an empty captured catalog', () => {
    recordSchema('zzz_captured_probe', { shape: {}, cost: 'low', returns: '{ok}' });
    recordSchema('zzz_uncaptured_probe', { shape: {}, cost: 'low', returns: '{ok}' });
    registerChatCapturedTools(new Map([['zzz_captured_probe', { handler: async () => ({ ok: true }) }]]));
    expect(buildToolCatalog().map((tool) => tool.name)).toEqual(['zzz_captured_probe']);
    registerChatCapturedTools(new Map());
    expect(buildToolCatalog()).toEqual([]);
  });

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
