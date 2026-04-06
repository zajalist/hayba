import { describe, it, expect } from 'vitest';
import type { PCGGraphJSON, ValidationError, UEStatus, CatalogNode } from './types.js';

describe('Types', () => {
  it('should define PCGGraphJSON structure', () => {
    const graph: PCGGraphJSON = {
      version: '2.0.0',
      meta: { sourceGraph: '/Game/Test', ueVersion: '5.7', exportedAt: '2026-01-01', tags: [] },
      nodes: [],
      edges: [],
      metadata: { inputSettings: {}, outputSettings: {}, graphSettings: {} }
    };
    expect(graph.version).toBe('2.0.0');
  });

  it('should define ValidationError structure', () => {
    const err: ValidationError = { type: 'schema', node: 'n1', pin: '', detail: 'test' };
    expect(err.type).toBe('schema');
  });

  it('should define CatalogNode structure', () => {
    const node: CatalogNode = {
      class: 'Test', category: 'Test', description: 'Test',
      inputs: [], outputs: [], key_properties: [], common_patterns: []
    };
    expect(node.class).toBe('Test');
  });
});
