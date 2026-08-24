import { describe, it, expect } from 'vitest';
import { searchNodes } from './catalog.js';
import type { CatalogNode } from './types.js';

describe('Catalog (structure validation)', () => {
  it('should validate catalog node structure', () => {
    const mockNode = {
      class: 'PCGExBuildDelaunayGraph2D',
      category: 'Clusters/Diagrams',
      description: 'test',
      inputs: [{ pin: 'In', type: 'Points', required: true }],
      outputs: [{ pin: 'Out', type: 'Points' }],
      key_properties: [{ name: 'bUrquhart', type: 'bool', default: 'false' }],
      common_patterns: ['test pattern']
    };

    expect(mockNode.class).toBeTruthy();
    expect(mockNode.inputs.length).toBeGreaterThan(0);
    expect(mockNode.outputs.length).toBeGreaterThan(0);
  });
});

const mk = (over: Partial<CatalogNode>): CatalogNode => ({
  class: '',
  category: '',
  description: '',
  inputs: [],
  outputs: [],
  key_properties: [],
  common_patterns: [],
  ...over,
});

const NODES: CatalogNode[] = [
  mk({
    class: 'UPCGExBuildDelaunayGraph2DSettings',
    category: 'PCGExElementsClustersDiagrams',
    description: 'Create a 2D delaunay triangulation for each input dataset.',
  }),
  mk({
    class: 'UPCGExRefineEdgesSettings',
    category: 'PCGExElementsClustersRefine',
    description: 'Refine edges of a cluster, e.g. minimum spanning tree.',
  }),
  mk({
    class: 'UPCGExFloodFillSettings',
    category: 'PCGExElementsFloodFill',
    description: 'Flood fill a cluster from seed vertices.',
  }),
];

describe('searchNodes — query tokenization', () => {
  it('single-word query still matches (regression of prior behavior)', () => {
    const r = searchNodes(NODES, 'Delaunay');
    expect(r.map(n => n.class)).toEqual(['UPCGExBuildDelaunayGraph2DSettings']);
  });

  it('multi-word query matches when ALL tokens appear across any fields', () => {
    // tokens: delaunay (description), 2d (class), cluster (category) — all present
    const r = searchNodes(NODES, 'Delaunay 2D cluster');
    expect(r.map(n => n.class)).toEqual(['UPCGExBuildDelaunayGraph2DSettings']);
  });

  it('multi-word query is order-independent', () => {
    const a = searchNodes(NODES, 'minimum spanning tree refine').map(n => n.class);
    const b = searchNodes(NODES, 'refine tree spanning minimum').map(n => n.class);
    expect(a).toEqual(['UPCGExRefineEdgesSettings']);
    expect(a).toEqual(b);
  });

  it('returns [] when any single token is absent (AND semantics)', () => {
    expect(searchNodes(NODES, 'Delaunay voronoi')).toEqual([]);
  });

  it('whitespace-only / empty query returns []', () => {
    expect(searchNodes(NODES, '   ')).toEqual([]);
  });
});

describe('searchNodes — haystack caching', () => {
  const heavy = (i: number): CatalogNode =>
    mk({
      class: `UPCGExNode${i}Settings`,
      category: 'PCGExElementsBench',
      description: `Bench node ${i} for repeated-search cost measurement.`,
      inputs: Array.from({ length: 8 }, (_, k) => ({
        pin: `In${k}`,
        type: 'Points',
        required: false,
        description: `input ${k} of node ${i}`,
      })),
      outputs: Array.from({ length: 8 }, (_, k) => ({ pin: `Out${k}`, type: 'Points' })),
      key_properties: Array.from({ length: 12 }, (_, k) => ({
        name: `bProperty${k}`,
        type: 'bool',
        default: 'false',
      })),
      common_patterns: [`pattern ${i} a`, `pattern ${i} b`],
    });

  it('does not rebuild searchable text on repeated queries', () => {
    // Asserted by observable behaviour, not by a stopwatch. A timing assertion
    // would measure the CI runner as much as the code, and a test that fails
    // when a machine is busy teaches people to re-run rather than to look.
    //
    // The cache is proven by its own side effect: mutate a node after it has
    // been searched once, and a cached implementation cannot see the change,
    // while a rebuild-every-query implementation would immediately.
    // "measurement" appears only in the description, so changing that field is
    // enough to flip the match. ("bench" would not work — it is also in the
    // category, which is exactly the kind of thing a haystack test should not
    // quietly depend on.)
    const node = heavy(1);
    expect(searchNodes([node], 'measurement').length).toBe(1);

    node.description = 'nothing relevant here';
    expect(searchNodes([node], 'measurement').length).toBe(1); // still cached

    // …and a node never searched before is built fresh, so this is a cache and
    // not a global short-circuit that matches everything.
    const fresh = heavy(2);
    fresh.description = 'nothing relevant here';
    expect(searchNodes([fresh], 'measurement').length).toBe(0);
  });

  it('cached results stay correct across repeated and differing queries', () => {
    const nodes = [heavy(1), heavy(2)];
    const first = searchNodes(nodes, 'bench').map(n => n.class);
    const narrowed = searchNodes(nodes, 'Node1Settings').map(n => n.class);
    const again = searchNodes(nodes, 'bench').map(n => n.class);

    expect(first).toEqual(['UPCGExNode1Settings', 'UPCGExNode2Settings']);
    expect(narrowed).toEqual(['UPCGExNode1Settings']);
    expect(again).toEqual(first);
  });

  it('matches text that only appears in pins and properties', () => {
    const nodes = [heavy(7)];
    expect(searchNodes(nodes, 'bProperty11').map(n => n.class)).toEqual(['UPCGExNode7Settings']);
    expect(searchNodes(nodes, 'Out5').map(n => n.class)).toEqual(['UPCGExNode7Settings']);
  });
});
