import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { KnowledgeStore } from './knowledge-store.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

describe('KnowledgeStore', () => {
  const tmpDir = path.join(tmpdir(), 'knowledge-store-test-' + Date.now());

  const sampleNodeRef = {
    Mountain: {
      category: 'primitive',
      description: 'Generates mountain terrain',
      ports: { in: ['In'], out: ['Out'] },
      parameters: { Style: { type: 'enum', default: 'Basic' } },
      tips: ['Use for alpine base shapes'],
      phase_hint: 'base',
      typical_predecessors: [],
      typical_successors: ['Erosion2', 'Snow'],
    },
    Erosion2: {
      category: 'simulation',
      description: 'Hydraulic erosion simulation',
      ports: { in: ['In', 'Mask'], out: ['Out', 'Wear', 'Flow'] },
      parameters: { Duration: { type: 'number', default: '0.5', range: '0-1' } },
      tips: ['Chain multiple for realism'],
      phase_hint: 'simulation',
      typical_predecessors: ['Mountain', 'Canyon'],
      typical_successors: ['ThermalShaper', 'Snow'],
    },
    Snow: {
      category: 'surface',
      description: 'Snow deposition',
      ports: { in: ['In'], out: ['Out'] },
      parameters: { Amount: { type: 'number', default: '0.5' } },
      tips: [],
      phase_hint: 'lookdev',
      typical_predecessors: ['Erosion2'],
      typical_successors: ['TextureBase'],
    },
  };

  const sampleBestPractices = {
    rules: [
      { id: 'bp-001', category: 'workflow', rule: 'Always erode before adding surface detail', source: 'guides/workflow' },
      { id: 'bp-002', category: 'simulation', rule: 'Chain multiple erosion nodes with decreasing duration', source: 'guides/erosion' },
      { id: 'bp-003', category: 'performance', rule: 'Keep graphs under 50 nodes', source: 'guides/optimization' },
    ],
  };

  const samplePatterns = {
    'erosion-chain': {
      nodes: ['Erosion2', 'ThermalShaper', 'Sediments'],
      connections: [
        { from: 'Erosion2', fromPort: 'Out', to: 'ThermalShaper', toPort: 'In' },
        { from: 'ThermalShaper', fromPort: 'Out', to: 'Sediments', toPort: 'In' },
      ],
      description: 'Standard erosion pipeline',
      when_to_use: 'After base shape is established',
      phase: 'simulation',
    },
  };

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(path.join(tmpDir, 'node-reference.json'), JSON.stringify(sampleNodeRef));
    writeFileSync(path.join(tmpDir, 'best-practices.json'), JSON.stringify(sampleBestPractices));
    writeFileSync(path.join(tmpDir, 'workflow-patterns.json'), JSON.stringify(samplePatterns));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads and returns a node by type', () => {
    const store = new KnowledgeStore(tmpDir);
    const node = store.getNode('Mountain');
    expect(node).not.toBeNull();
    expect(node!.category).toBe('primitive');
    expect(node!.phase_hint).toBe('base');
  });

  it('returns null for unknown node', () => {
    const store = new KnowledgeStore(tmpDir);
    expect(store.getNode('FakeNode')).toBeNull();
  });

  it('filters best practices by phase', () => {
    const store = new KnowledgeStore(tmpDir);
    const rules = store.getBestPractices({ phase: 'simulation' });
    expect(rules.length).toBeGreaterThanOrEqual(1);
    expect(rules.some(r => r.category === 'simulation')).toBe(true);
  });

  it('filters best practices by node types', () => {
    const store = new KnowledgeStore(tmpDir);
    const rules = store.getBestPractices({ nodeTypes: ['Erosion2'] });
    expect(rules.length).toBeGreaterThanOrEqual(1);
  });

  it('returns all best practices with no filter', () => {
    const store = new KnowledgeStore(tmpDir);
    const rules = store.getBestPractices({});
    expect(rules.length).toBe(3);
  });

  it('finds workflow patterns by phase', () => {
    const store = new KnowledgeStore(tmpDir);
    const patterns = store.findPatterns({ phase: 'simulation' });
    expect(patterns.length).toBe(1);
    expect(patterns[0].nodes).toContain('Erosion2');
  });

  it('finds workflow patterns by description keyword', () => {
    const store = new KnowledgeStore(tmpDir);
    const patterns = store.findPatterns({ description: 'erosion' });
    expect(patterns.length).toBe(1);
  });

  it('gets node neighbors', () => {
    const store = new KnowledgeStore(tmpDir);
    const neighbors = store.getNodeNeighbors('Erosion2');
    expect(neighbors.predecessors).toContain('Mountain');
    expect(neighbors.successors).toContain('ThermalShaper');
  });

  it('returns empty neighbors for unknown node', () => {
    const store = new KnowledgeStore(tmpDir);
    const neighbors = store.getNodeNeighbors('FakeNode');
    expect(neighbors.predecessors).toEqual([]);
    expect(neighbors.successors).toEqual([]);
  });

  describe('zone_strategy', () => {
    const nodeRefWithZone = {
      Mountain: {
        category: 'primitive',
        description: 'Generates mountain terrain',
        ports: { in: [], out: ['Out'] },
        parameters: { Scale: { type: 'float', default: '1.0' }, Height: { type: 'float', default: '0.5' } },
        tips: [],
        phase_hint: 'base',
        typical_predecessors: [],
        typical_successors: ['Erosion2'],
        zone_strategy: 'position',
        position_params: [],
      },
      Island: {
        category: 'primitive',
        description: 'Generates island terrain',
        ports: { in: [], out: ['Out'] },
        parameters: { Scale: { type: 'float', default: '1.0' } },
        tips: [],
        phase_hint: 'base',
        typical_predecessors: [],
        typical_successors: ['Erosion2'],
        zone_strategy: 'mask',
        position_params: [],
      },
      Erosion2: {
        category: 'simulation',
        description: 'Hydraulic erosion simulation',
        ports: { in: ['In'], out: ['Out'] },
        parameters: { Duration: { type: 'float', default: '0.5' } },
        tips: [],
        phase_hint: 'simulation',
        typical_predecessors: ['Mountain'],
        typical_successors: [],
        zone_strategy: 'none',
        position_params: [],
      },
    };

    let zoneDir: string;
    beforeAll(() => {
      zoneDir = path.join(tmpdir(), 'knowledge-zone-test-' + Date.now());
      mkdirSync(zoneDir, { recursive: true });
      writeFileSync(path.join(zoneDir, 'node-reference.json'), JSON.stringify(nodeRefWithZone));
    });

    afterAll(() => {
      rmSync(zoneDir, { recursive: true, force: true });
    });

    it('returns zone_strategy "position" for Mountain (positioned via Transform, no direct X/Y params)', () => {
      const store = new KnowledgeStore(zoneDir);
      const node = store.getNode('Mountain');
      expect(node).not.toBeNull();
      expect(node!.zone_strategy).toBe('position');
      expect(node!.position_params).toEqual([]);
    });

    it('returns zone_strategy "mask" with empty position_params for Island', () => {
      const store = new KnowledgeStore(zoneDir);
      const node = store.getNode('Island');
      expect(node).not.toBeNull();
      expect(node!.zone_strategy).toBe('mask');
      expect(node!.position_params).toEqual([]);
    });

    it('returns zone_strategy "none" with empty position_params for Erosion2', () => {
      const store = new KnowledgeStore(zoneDir);
      const node = store.getNode('Erosion2');
      expect(node).not.toBeNull();
      expect(node!.zone_strategy).toBe('none');
      expect(node!.position_params).toEqual([]);
    });
  });
});
