import { describe, it, expect } from 'vitest';
import { brainstormGaeaHandler, type BrainstormGaeaResult } from '../../src/tools/hayba-brainstorm-gaea.js';

describe('hayba_brainstorm_gaea', () => {
  it('returns archetypes, best_practices, and node_zone_strategies on start', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'alpine mountain with sharp ridges',
      step: 'start',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    expect(data.step).toBe('start');
    expect(Array.isArray(data.archetypes)).toBe(true);
    expect(data.archetypes.length).toBeGreaterThan(0);
    expect(Array.isArray(data.best_practices)).toBe(true);
    expect(data.node_zone_strategies).toBeDefined();
    expect(typeof data.node_zone_strategies).toBe('object');
  });

  it('returns follow-up questions for prompts without scale info', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'snowy mountain',
      step: 'start',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    // Should ask about scale since it's not specified
    expect(data.follow_up_questions.length + (data.suggested_plan ? 1 : 0)).toBeGreaterThan(0);
  });

  it('returns a scratch session ID and painterUrl on zones step', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'desert canyon',
      step: 'zones',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    expect(data.step).toBe('zones');
    expect(data.scratchSessionId).toBeDefined();
    expect(typeof data.scratchSessionId).toBe('string');
    expect(data.painterUrl).toBeDefined();
    expect(data.painterUrl).toContain('scratch');
  });

  it('returns a final graph on finalize step', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'volcanic island',
      step: 'finalize',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    expect(data.step).toBe('finalize');
    expect(data.final_graph).toBeDefined();
    expect(data.final_graph!.nodes.length).toBeGreaterThan(0);
    expect(data.final_graph!.edges.length).toBeGreaterThan(0);
  });

  it('returns error when prompt is missing', async () => {
    const result = await brainstormGaeaHandler({ step: 'start' });
    expect(result.isError).toBe(true);
  });

  it('returns error for unknown step', async () => {
    const result = await brainstormGaeaHandler({ prompt: 'test', step: 'unknown' });
    expect(result.isError).toBe(true);
  });
});
