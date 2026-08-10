import { describe, it, expect } from 'vitest';
import { formatGraphTopology } from './format-graph-topology.js';
import type { PCGNode } from '../types.js';

function node(id: string, cls = 'UPCGExSampleNearest'): PCGNode {
  return { id, class: cls, label: id, position: { x: -1, y: -1 }, properties: {}, customData: {} };
}

function graph(nodes: PCGNode[], edges: Array<{ fromNode: string; toNode: string }>) {
  return JSON.stringify({
    version: '2',
    meta: { sourceGraph: 'g', ueVersion: '5.7', exportedAt: '', tags: [] },
    nodes,
    edges: edges.map((e) => ({ fromNode: e.fromNode, fromPin: 'Out', toNode: e.toNode, toPin: 'In' })),
    metadata: { inputSettings: {} },
  });
}

describe('formatGraphTopology — layered algorithm', () => {
  it('places a linear chain in successive layers along x, at the same y', async () => {
    const g = graph([node('a'), node('b'), node('c')], [
      { fromNode: 'a', toNode: 'b' },
      { fromNode: 'b', toNode: 'c' },
    ]);
    const out = JSON.parse(await formatGraphTopology({ graph: g, algorithm: 'layered', nodeWidth: 200, nodeHeight: 100, horizontalSpacing: 150, verticalSpacing: 80, addCommentBlocks: false }));
    const byId = Object.fromEntries(out.nodes.map((n: PCGNode) => [n.id, n.position]));
    expect(byId.a.x).toBe(0);
    expect(byId.b.x).toBe(350); // nodeWidth + horizontalSpacing
    expect(byId.c.x).toBe(700);
    expect(byId.a.y).toBe(0);
    expect(byId.b.y).toBe(0);
  });

  it('stacks sibling nodes at the same layer vertically, ordered deterministically by id', async () => {
    const g = graph([node('root'), node('z_child'), node('a_child')], [
      { fromNode: 'root', toNode: 'z_child' },
      { fromNode: 'root', toNode: 'a_child' },
    ]);
    const out = JSON.parse(await formatGraphTopology({ graph: g, algorithm: 'layered', nodeWidth: 200, nodeHeight: 100, horizontalSpacing: 150, verticalSpacing: 80, addCommentBlocks: false }));
    const byId = Object.fromEntries(out.nodes.map((n: PCGNode) => [n.id, n.position]));
    // Same layer (x) for both children.
    expect(byId.z_child.x).toBe(byId.a_child.x);
    // Sorted by id: 'a_child' < 'z_child', so a_child gets row 0 (y=0).
    expect(byId.a_child.y).toBe(0);
    expect(byId.z_child.y).toBe(180); // nodeHeight + verticalSpacing
  });

  it('does not hang or drop nodes on a cyclic graph — unvisited nodes fall back to layer 0', async () => {
    const g = graph([node('a'), node('b')], [
      { fromNode: 'a', toNode: 'b' },
      { fromNode: 'b', toNode: 'a' },
    ]);
    const out = JSON.parse(await formatGraphTopology({ graph: g, algorithm: 'layered', nodeWidth: 200, nodeHeight: 100, horizontalSpacing: 150, verticalSpacing: 80, addCommentBlocks: false }));
    expect(out.nodes).toHaveLength(2);
    for (const n of out.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  it('accepts legacy from/to edge keys via normalizeEdges', async () => {
    const g = JSON.stringify({
      version: '2',
      meta: { sourceGraph: 'g', ueVersion: '5.7', exportedAt: '', tags: [] },
      nodes: [node('a'), node('b')],
      edges: [{ from: 'a', to: 'b' }],
      metadata: { inputSettings: {} },
    });
    const out = JSON.parse(await formatGraphTopology({ graph: g, algorithm: 'layered', nodeWidth: 200, nodeHeight: 100, horizontalSpacing: 150, verticalSpacing: 80, addCommentBlocks: false }));
    const byId = Object.fromEntries(out.nodes.map((n: PCGNode) => [n.id, n.position]));
    expect(byId.b.x).toBeGreaterThan(byId.a.x);
  });
});

describe('formatGraphTopology — grid algorithm', () => {
  it('lays nodes out in a square-ish grid using ceil(sqrt(n)) columns', async () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => node(id));
    const g = graph(nodes, []);
    const out = JSON.parse(await formatGraphTopology({ graph: g, algorithm: 'grid', nodeWidth: 200, nodeHeight: 100, horizontalSpacing: 150, verticalSpacing: 80, addCommentBlocks: false }));
    // sqrt(4) = 2 columns exactly.
    const byId = Object.fromEntries(out.nodes.map((n: PCGNode) => [n.id, n.position]));
    expect(byId.a.position).toBeUndefined(); // sanity: no nested position key
    expect(byId.a.x).toBe(0);
    expect(byId.b.x).toBe(350);
    expect(byId.c.x).toBe(0);
    expect(byId.c.y).toBe(180);
  });
});

describe('formatGraphTopology — comment blocks', () => {
  it('adds no comment block for a lone node of a class (needs >= 2 to group)', async () => {
    const g = graph([node('a', 'UPCGExSampleNearest')], []);
    const out = JSON.parse(await formatGraphTopology({ graph: g, algorithm: 'grid', nodeWidth: 200, nodeHeight: 100, horizontalSpacing: 150, verticalSpacing: 80, addCommentBlocks: true }));
    expect(out.nodes.filter((n: PCGNode) => n.class === 'PCGCommentSettings')).toHaveLength(0);
  });

  it('groups >= 2 nodes sharing a class prefix into one comment block, sized around them', async () => {
    const g = graph([node('a', 'UPCGExSampleNearest'), node('b', 'UPCGExSampleFar')], []);
    const out = JSON.parse(await formatGraphTopology({ graph: g, algorithm: 'grid', nodeWidth: 200, nodeHeight: 100, horizontalSpacing: 150, verticalSpacing: 80, addCommentBlocks: true }));
    const comments = out.nodes.filter((n: PCGNode) => n.class === 'PCGCommentSettings');
    expect(comments).toHaveLength(1);
    expect(comments[0].properties.Width).toBeGreaterThan(0);
    expect(comments[0].properties.Height).toBeGreaterThan(0);
  });

  it('rejects malformed JSON with a clear error, not a raw parser exception', async () => {
    await expect(
      formatGraphTopology({ graph: '{not json', algorithm: 'layered', nodeWidth: 200, nodeHeight: 100, horizontalSpacing: 150, verticalSpacing: 80, addCommentBlocks: false }),
    ).rejects.toThrow('Invalid JSON graph payload');
  });
});
