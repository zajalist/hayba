import { describe, it, expect } from 'vitest';
import { HaybaMemory } from '../../../src/gaea/memory/hayba-memory.js';

describe('HaybaMemory', () => {
  it('writes and queries shared blocks', () => {
    const m = new HaybaMemory(':memory:');
    m.write({
      agentRole: 'director',
      scope: 'shared',
      intent: 'establish biome plan',
      content: 'forest -> river -> ruins',
      accessedResources: [],
      tokenCost: 12,
    });
    const blocks = m.query({ scope: 'shared', limit: 10 });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].intent).toBe('establish biome plan');
  });

  it('filters by agentRole', () => {
    const m = new HaybaMemory(':memory:');
    m.write({ agentRole: 'director', scope: 'shared', intent: 'i1', content: 'c1', accessedResources: [], tokenCost: 1 });
    m.write({ agentRole: 'asset-manager', scope: 'shared', intent: 'i2', content: 'c2', accessedResources: [], tokenCost: 1 });
    const blocks = m.query({ agentRole: 'director' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].intent).toBe('i1');
  });

  it('orders by timestamp DESC', () => {
    const m = new HaybaMemory(':memory:');
    m.write({ agentRole: 'd', scope: 'shared', intent: 'old', content: '', accessedResources: [], tokenCost: 0, timestamp: 1000 });
    m.write({ agentRole: 'd', scope: 'shared', intent: 'new', content: '', accessedResources: [], tokenCost: 0, timestamp: 2000 });
    const blocks = m.query({});
    expect(blocks[0].intent).toBe('new');
    expect(blocks[1].intent).toBe('old');
  });

  it('clear(role) removes only that role', () => {
    const m = new HaybaMemory(':memory:');
    m.write({ agentRole: 'a', scope: 'shared', intent: 'x', content: '', accessedResources: [], tokenCost: 0 });
    m.write({ agentRole: 'b', scope: 'shared', intent: 'y', content: '', accessedResources: [], tokenCost: 0 });
    m.clear('a');
    const blocks = m.query({});
    expect(blocks).toHaveLength(1);
    expect(blocks[0].agentRole).toBe('b');
  });

  it('clear() with no arg removes all', () => {
    const m = new HaybaMemory(':memory:');
    m.write({ agentRole: 'a', scope: 'shared', intent: 'x', content: '', accessedResources: [], tokenCost: 0 });
    m.clear();
    expect(m.query({})).toHaveLength(0);
  });

  it('preserves accessedResources and provenance round-trip', () => {
    const m = new HaybaMemory(':memory:');
    m.write({
      agentRole: 'd', scope: 'shared',
      intent: 'i', content: 'c',
      accessedResources: ['/Game/A.A', '/Game/B.B'],
      tokenCost: 5,
      provenance: { tool: 'asset_search', cursor: 'abc' },
    });
    const blocks = m.query({});
    expect(blocks[0].accessedResources).toEqual(['/Game/A.A', '/Game/B.B']);
    expect(blocks[0].provenance).toEqual({ tool: 'asset_search', cursor: 'abc' });
  });
});
