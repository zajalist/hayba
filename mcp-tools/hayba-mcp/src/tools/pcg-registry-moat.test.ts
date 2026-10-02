import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseCatalogData } from '../catalog.js';
import type { CatalogNode, NodeCatalog } from '../types.js';
import {
  compatiblePins,
  diffCatalogs,
  getPatternTemplate,
  searchNodeCatalogSemantic,
} from './pcg-registry-moat.js';

vi.mock('node:fs', async importOriginal => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeFileSync: vi.fn(),
}));

const node = (overrides: Partial<CatalogNode>): CatalogNode => ({
  class: '',
  category: '',
  description: '',
  inputs: [],
  outputs: [],
  key_properties: [],
  common_patterns: [],
  ...overrides,
});

const roadSpline = node({
  class: 'UPCGExPathfindingEdgesSettings',
  category: 'Paths',
  description: 'Find routes over a cluster and emit spline paths.',
  inputs: [{ pin: 'Seeds', type: 'point', required: true }],
  outputs: [{ pin: 'Paths', type: 'spline' }],
});

const meshSampler = node({
  class: 'UPCGSurfaceSamplerSettings',
  category: 'Sampling',
  description: 'Sample points on a static mesh surface.',
  inputs: [{ pin: 'Surface', type: 'surface', required: true }],
  outputs: [{ pin: 'Points', type: 'point' }],
});

describe('semantic node catalog search', () => {
  it('ranks a path node for road-generation intent without literal road text', () => {
    const results = searchNodeCatalogSemantic([meshSampler, roadSpline], 'nodes for road generation', 2);

    expect(results.map(result => result.node.class)).toEqual([
      'UPCGExPathfindingEdgesSettings',
      'UPCGSurfaceSamplerSettings',
    ]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('honours k and returns no zero-similarity filler', () => {
    const results = searchNodeCatalogSemantic([roadSpline, meshSampler], 'sample terrain points', 1);

    expect(results).toHaveLength(1);
    expect(results[0].node.class).toBe('UPCGSurfaceSamplerSettings');
  });
});

describe('pin compatibility', () => {
  const consumers = [
    roadSpline,
    node({
      class: 'UPCGExPointFilterSettings',
      inputs: [{ pin: 'In', type: 'any', required: true }],
    }),
    node({
      class: 'UPCGExSplineSamplerSettings',
      inputs: [{ pin: 'Spline', type: 'spline', required: true }],
    }),
  ];

  it('returns exact and Any inputs for a known output pin', () => {
    const matches = compatiblePins([meshSampler, ...consumers], 'UPCGSurfaceSamplerSettings', 'Points');

    expect(matches).toEqual([
      {
        node_class: 'UPCGExPathfindingEdgesSettings',
        pin: 'Seeds',
        type: 'point',
        compatibility: 'exact',
      },
      {
        node_class: 'UPCGExPointFilterSettings',
        pin: 'In',
        type: 'any',
        compatibility: 'wildcard',
      },
    ]);
  });

  it('fails clearly when the source class or output pin is unknown', () => {
    expect(() => compatiblePins(consumers, 'MissingClass', 'Out')).toThrow(/MissingClass/);
    expect(() => compatiblePins([meshSampler], meshSampler.class, 'MissingPin')).toThrow(/MissingPin/);
  });
});

describe('common-pattern templates', () => {
  const shippedCatalog = parseCatalogData(JSON.parse(readFileSync(
    new URL('../../../../unreal/HaybaMCPToolkit/Resources/node_catalog.json', import.meta.url), 'utf8',
  )));

  it('selects a road/path template by intent and explains when to use it', () => {
    const result = getPatternTemplate('build roads between settlements', shippedCatalog);

    expect('id' in result).toBe(true);
    if (!('id' in result)) throw new Error('expected a matching template');
    expect(result.id).toBe('road-network');
    expect(result.use_when).toMatch(/route|road/i);
    expect(result.nodes.length).toBeGreaterThan(1);
    expect(result.edges.length).toBeGreaterThan(0);
    expect(result.preflight.requiresLiveValidation).toBe(true);
    expect(result.preflight.scope).toBe('catalog_only');
    expect(result.preflight.edge_checks.map(edge => edge.status)).toEqual(['absent', 'unknown']);
    expect(result.preflight.pin_checks).toContainEqual({
      node: 'pathfind', direction: 'input', pin: 'Cluster', status: 'absent',
    });
    expect(result.preflight.pin_checks).toContainEqual({
      node: 'spline', direction: 'input', pin: 'Paths', status: 'unknown',
    });
  });

  it('exposes shipped refinement mismatch without asserting live plugin state', () => {
    const result = getPatternTemplate('refine cluster edges', shippedCatalog);
    if (!('id' in result)) throw new Error('expected a matching template');
    expect(result.id).toBe('cluster-refinement');
    expect(result.preflight.class_checks.every(check => check.status === 'confirmed')).toBe(true);
    expect(result.preflight.pin_checks.find(check => check.node === 'refine' && check.pin === 'Cluster')?.status).toBe('absent');
    expect(result.preflight.edge_checks[0].status).toBe('absent');
  });

  it('marks classes outside the shipped catalog absent from catalog evidence only', () => {
    const result = getPatternTemplate('scatter points across terrain', shippedCatalog);
    if (!('id' in result)) throw new Error('expected a matching template');
    expect(result.id).toBe('surface-scatter');
    expect(result.preflight.class_checks.map(check => check.status)).toEqual(['absent', 'absent', 'absent']);
    expect(result.preflight.pin_checks.every(check => check.status === 'unknown')).toBe(true);
    expect(result.preflight.edge_checks.every(check => check.status === 'unknown')).toBe(true);
    expect(result.preflight.requiresLiveValidation).toBe(true);
  });

  it('confirms complete catalog pins while retaining live validation', () => {
    const complete: NodeCatalog = { version: 'fixture-complete', categories: [], nodes: [
      node({ class: 'UPCGExBuildDelaunayGraph2DSettings', outputs: [{ pin: 'Edges', type: 'points' }] }),
      node({ class: 'UPCGExPathfindingEdgesSettings', inputs: [{ pin: 'Cluster', type: 'points' }], outputs: [{ pin: 'Paths', type: 'points' }] }),
      node({ class: 'UPCGExCreateSplineSettings', inputs: [{ pin: 'Paths', type: 'points' }] }),
    ] };
    const result = getPatternTemplate('roads between settlements', complete);
    if (!('id' in result)) throw new Error('expected a matching template');
    expect(result.preflight.class_checks.map(check => check.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(result.preflight.pin_checks.map(check => check.status)).toEqual(['confirmed', 'confirmed', 'confirmed', 'confirmed']);
    expect(result.preflight.edge_checks.map(check => check.status)).toEqual(['confirmed', 'confirmed']);
    expect(result.preflight.edge_checks.map(check => check.type_compatibility)).toEqual(['compatible', 'compatible']);
    expect(result.preflight.requiresLiveValidation).toBe(true);
  });

  it('does not confirm an edge whose catalog pin types conflict', () => {
    const mismatched: NodeCatalog = { version: 'fixture-mismatch', categories: [], nodes: [
      node({ class: 'UPCGExBuildDelaunayGraph2DSettings', outputs: [{ pin: 'Edges', type: 'points' }] }),
      node({ class: 'UPCGExRefineEdgesSettings', inputs: [{ pin: 'Cluster', type: 'spline' }] }),
    ] };
    const result = getPatternTemplate('refine cluster edges', mismatched);
    if (!('id' in result)) throw new Error('expected a matching template');
    expect(result.preflight.pin_checks.map(check => check.status)).toEqual(['confirmed', 'confirmed']);
    expect(result.preflight.edge_checks[0]).toMatchObject({
      status: 'unknown', type_compatibility: 'incompatible',
    });
    expect(result.preflight.requiresLiveValidation).toBe(true);
  });

  it('returns the template with unknown checks when catalog evidence is unavailable', () => {
    const result = getPatternTemplate('roads between settlements', null);
    if (!('id' in result)) throw new Error('expected a matching template');
    expect(result.id).toBe('road-network');
    expect(result.preflight.catalog_version).toBeNull();
    expect(result.preflight.class_checks.every(check => check.status === 'unknown')).toBe(true);
    expect(result.preflight.pin_checks.every(check => check.status === 'unknown')).toBe(true);
    expect(result.preflight.edge_checks.every(check => check.status === 'unknown' && check.type_compatibility === 'unknown')).toBe(true);
    expect(result.preflight.requiresLiveValidation).toBe(true);
  });

  it('treats empty and dynamic pin lists as unknown and does not write a graph', () => {
    const dynamic: NodeCatalog = { version: 'fixture-dynamic', categories: [], nodes: [
      node({ class: 'UPCGExBuildDelaunayGraph2DSettings', outputs: [{ pin: 'GetMainOutputPin(', type: 'points' }] }),
      node({ class: 'UPCGExRefineEdgesSettings', inputs: [] }),
    ] };
    const before = JSON.stringify(dynamic);
    const result = getPatternTemplate('refine cluster edges', dynamic);
    if (!('id' in result)) throw new Error('expected a matching template');
    expect(result.preflight.pin_checks.map(check => check.status)).toEqual(['unknown', 'unknown']);
    expect(result.preflight.edge_checks[0].status).toBe('unknown');
    expect(JSON.stringify(dynamic)).toBe(before);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('returns a ranked discovery list when no intent has meaningful overlap', () => {
    const result = getPatternTemplate('quantum banana');

    expect(result).toEqual({
      template: null,
      available: ['road-network', 'surface-scatter', 'cluster-refinement'],
    });
  });
});

describe('catalog version diff', () => {
  const catalog = (version: string, nodes: CatalogNode[]): NodeCatalog => ({
    version,
    categories: [],
    nodes,
  });

  it('reports stable added, removed, and field-level modified classes', () => {
    const before = catalog('1.0', [
      roadSpline,
      node({ class: 'URemovedSettings', description: 'old' }),
      node({ class: 'UChangedSettings', description: 'before' }),
    ]);
    const after = catalog('2.0', [
      roadSpline,
      node({ class: 'UAddedSettings', description: 'new' }),
      node({ class: 'UChangedSettings', description: 'after' }),
    ]);

    expect(diffCatalogs(before, after)).toEqual({
      from_version: '1.0',
      to_version: '2.0',
      added: ['UAddedSettings'],
      removed: ['URemovedSettings'],
      modified: [{ class: 'UChangedSettings', fields: ['description'] }],
    });
  });

  it('ignores node ordering and reports pin changes', () => {
    const changed = { ...meshSampler, outputs: [{ pin: 'Samples', type: 'point' }] };

    expect(diffCatalogs(catalog('1', [roadSpline, meshSampler]), catalog('1', [changed, roadSpline]))).toEqual({
      from_version: '1',
      to_version: '1',
      added: [],
      removed: [],
      modified: [{ class: meshSampler.class, fields: ['outputs'] }],
    });
  });

  it('compares real catalog nodes with undefined optional property fields', () => {
    const withOptional = node({
      class: 'UOptionalSettings',
      key_properties: [{ name: 'Mode', type: 'enum', default: undefined, enum_values: undefined }],
    });

    expect(diffCatalogs(catalog('1', [withOptional]), catalog('1', [withOptional]))).toEqual({
      from_version: '1',
      to_version: '1',
      added: [],
      removed: [],
      modified: [],
    });
  });
});
