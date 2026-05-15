import { describe, it, expect } from 'vitest';
import { brainstormGaeaHandler, type BrainstormGaeaResult } from '../../src/tools/hayba-brainstorm-gaea.js';

describe('brainstorm-gaea integration', () => {
  it('full flow: start → followup → finalize', async () => {
    // Step 1: start
    const startResult = await brainstormGaeaHandler({
      prompt: 'snowy alpine mountain with sharp ridges and erosion',
      step: 'start',
    });
    expect(startResult.isError).toBeFalsy();
    const start = JSON.parse(startResult.content[0].text) as BrainstormGaeaResult;
    expect(start.archetypes.length).toBeGreaterThan(0);
    expect(start.node_zone_strategies).toBeDefined();

    // Verify zone strategies are populated for archetype nodes
    const nodeTypes = [...new Set(start.archetypes.flatMap(a => a.core_topology))];
    for (const nt of nodeTypes) {
      if (start.node_zone_strategies[nt]) {
        expect(['position', 'mask', 'none']).toContain(start.node_zone_strategies[nt].strategy);
      }
    }

    // Step 2: followup with answer
    const followResult = await brainstormGaeaHandler({
      prompt: 'snowy alpine mountain with sharp ridges and erosion',
      step: 'followup',
      answer: 'mid scale 8km, sharp ridges, with snow coloring',
    });
    expect(followResult.isError).toBeFalsy();
    const follow = JSON.parse(followResult.content[0].text) as BrainstormGaeaResult;
    expect(follow.archetypes.length).toBeGreaterThan(0);

    // Step 3: finalize
    const finalResult = await brainstormGaeaHandler({
      prompt: 'snowy alpine mountain with sharp ridges and erosion',
      step: 'finalize',
    });
    expect(finalResult.isError).toBeFalsy();
    const final = JSON.parse(finalResult.content[0].text) as BrainstormGaeaResult;
    expect(final.final_graph).not.toBeNull();
    expect(final.final_graph!.nodes.length).toBeGreaterThan(0);
    expect(final.final_graph!.edges.length).toBeGreaterThan(0);
  });

  it('zones step creates scratch session with correct URL format', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'desert with canyons',
      step: 'zones',
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    expect(data.scratchSessionId).toBeDefined();
    expect(data.painterUrl).toContain('scratch');
    expect(data.painterUrl).toContain(data.scratchSessionId);
  });

  it('node_zone_strategies contains only valid strategy values', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'volcanic island with lava fields',
      step: 'start',
    });
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    for (const [, v] of Object.entries(data.node_zone_strategies)) {
      expect(['position', 'mask', 'none']).toContain(v.strategy);
      expect(Array.isArray(v.position_params)).toBe(true);
    }
  });

  it('suggested_plan nodes match core_topology of top archetype', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'mountain erosion terrain',
      step: 'start',
    });
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    if (data.suggested_plan && data.archetypes.length > 0) {
      const planNodeTypes = data.suggested_plan.nodes.map(n => n.type);
      const archetypeTopology = data.archetypes[0].core_topology;
      // All plan node types should come from the archetype topology
      for (const t of planNodeTypes) {
        expect(archetypeTopology).toContain(t);
      }
    }
  });
});
