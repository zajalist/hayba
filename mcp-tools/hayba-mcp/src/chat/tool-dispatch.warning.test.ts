import { describe, expect, it } from 'vitest';
import { applyAdvisoryVerbosity } from '../tools/advisory-verbosity.js';
import { createChatDispatcher } from './tool-dispatch.js';
import { runLegacyAgentLoop as runAgentLoop } from './agent-loop.js';
import type { LLMClient, LLMStreamEvent, LLMMessage } from '../agents/llm-client.js';

describe('captured-tool warning delivery', () => {
  it('keeps second-block warning IDs across the real chat dispatcher into the model', async () => {
    const raw = {
      content: [
        { type: 'text' as const, text: '{"ok":true}' },
        { type: 'text' as const, text: JSON.stringify({ validator: { findings: [
          { ruleId: 'ui_engine_default_font', severity: 'warning', message: 'Widget A uses Roboto', context: { widget: 'A' } },
          { ruleId: 'ui_engine_default_font', severity: 'warning', message: 'Widget B uses Roboto', context: { widget: 'B' } },
        ] } }) },
      ],
    };
    const filtered = applyAdvisoryVerbosity(raw, 'errors_only');
    const visible = applyAdvisoryVerbosity(raw, 'errors_and_warnings');
    const visibleResult = await createChatDispatcher({ captured: new Map([['validator_run', { handler: async () => visible }]]) })('validator_run', {});
    expect((visibleResult as { validator: { findings: unknown[]; warning_ids: string[] } }).validator.findings).toHaveLength(2);
    expect((visibleResult as { validator: { findings: unknown[]; warning_ids: string[] } }).validator.warning_ids).toHaveLength(2);
    const dispatcher = createChatDispatcher({ captured: new Map([['validator_run', { handler: async () => filtered }]]) });
    const seen: LLMMessage[][] = [];
    let turn = 0;
    const client: LLMClient = {
      provider: 'mock', model: 'fake', protocol: 'anthropic',
      async complete() { throw new Error('unused'); },
      async *stream(params): AsyncGenerator<LLMStreamEvent, void, unknown> {
        seen.push(params.messages.map((m) => ({ ...m })));
        turn++;
        yield { type: 'done', response: turn === 1
          ? { content: null, toolCalls: [{ id: 'v1', name: 'validator_run', input: {} }], stopReason: 'tool_use' }
          : { content: 'Needs font review.', toolCalls: [], stopReason: 'end_turn' } };
      },
    };
    const events = [];
    for await (const event of runAgentLoop({
      client, system: 'sys', messages: [{ role: 'user', content: 'check fonts' }],
      tools: [{ name: 'validator_run', description: 'validate', input_schema: { type: 'object', properties: {} } }],
      dispatchTool: dispatcher,
    })) events.push(event);
    const IDs = (filtered.content.at(-1) as { text: string }).text;
    expect(JSON.parse(IDs).validator.warning_ids).toHaveLength(2);
    expect(JSON.stringify(seen[1])).toContain('ui_engine_default_font');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'warnings_unreviewed' });
    expect((events.at(-1) as { pendingWarningIds: string[] }).pendingWarningIds).toHaveLength(2);
  });
});
