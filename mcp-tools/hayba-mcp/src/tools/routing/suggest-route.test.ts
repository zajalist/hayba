import { describe, expect, it, vi } from 'vitest';
import type { CapturedTool } from './register.js';
import { suggestRoute } from './suggest-route.js';

const captured = new Map<string, CapturedTool>([
  'actor_list', 'actor_transform', 'material_get_info', 'editor_get_state',
].map((name) => [name, { schema: {}, handler: () => undefined, dir: null }]));

describe('suggestRoute', () => {
  it('offers only captured, enabled tools and installed local workflow IDs', async () => {
    const result = await suggestRoute('refine_scene', 'draft', false, {
      captured,
      disabled: (name) => name === 'actor_transform',
      workflowExists: (id) => id === 'hayba-refine-scene',
    });
    expect(result.candidates).toEqual([
      { kind: 'workflow_skill', id: 'hayba-refine-scene' },
      { kind: 'tool', id: 'actor_list' },
      { kind: 'tool', id: 'material_get_info' },
    ]);
    expect(result.suggested).toEqual(result.candidates[0]);
  });

  it('keeps explore advice read-only and falls back when Brain is unavailable', async () => {
    const rankRoute = vi.fn().mockResolvedValue(null);
    const result = await suggestRoute('refine_scene', 'explore', true, {
      captured, connector: { rankRoute } as never, workflowExists: () => true, disabled: () => false,
    });
    expect(result.candidates).toEqual([
      { kind: 'tool', id: 'actor_list' }, { kind: 'tool', id: 'material_get_info' },
    ]);
    expect(rankRoute).toHaveBeenCalledWith('refine_scene', 'explore', ['actor_list', 'material_get_info']);
    expect(result).toMatchObject({ source: 'local', suggested: { id: 'actor_list' } });
  });

  it('ignores a Brain choice outside the offered shortlist', async () => {
    const result = await suggestRoute('inspect_scene', 'draft', true, {
      captured, connector: { rankRoute: async () => 'actor_transform' } as never,
      disabled: () => false,
    });
    expect(result).toMatchObject({ source: 'local', suggested: { id: 'editor_get_state' } });
  });

  it('uses the local order if the Brain connector rejects', async () => {
    const result = await suggestRoute('inspect_scene', 'draft', true, {
      captured, connector: { rankRoute: async () => { throw new Error('offline'); } } as never,
      disabled: () => false,
    });
    expect(result).toMatchObject({ source: 'local', suggested: { id: 'editor_get_state' } });
  });
});
