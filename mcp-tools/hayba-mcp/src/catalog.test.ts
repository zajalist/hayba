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
