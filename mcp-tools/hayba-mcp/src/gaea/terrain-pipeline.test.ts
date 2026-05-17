import { describe, it, expect } from 'vitest';
import { analyzeTerrainIntent, computeComplexityScore } from './terrain-pipeline.js';

describe('analyzeTerrainIntent', () => {
  it('detects alpine biome and erosion process', () => {
    const intent = analyzeTerrainIntent('Rocky alpine peaks with heavy erosion and snow');
    expect(intent.biome).toBe('alpine');
    expect(intent.geologicalProcesses).toContain('erosion');
    expect(intent.targetPhase).toBeUndefined();
  });

  it('detects desert biome', () => {
    const intent = analyzeTerrainIntent('Arid desert canyons with sand dunes');
    expect(intent.biome).toBe('desert');
  });

  it('detects volcanic process', () => {
    const intent = analyzeTerrainIntent('Volcanic wasteland with lava flows');
    expect(intent.geologicalProcesses).toContain('volcanic');
  });

  it('estimates node count for simple terrain', () => {
    const intent = analyzeTerrainIntent('Simple mountain');
    expect(intent.estimatedNodeCount).toBeGreaterThanOrEqual(3);
    expect(intent.estimatedNodeCount).toBeLessThanOrEqual(8);
  });

  it('estimates higher node count for complex terrain', () => {
    const intent = analyzeTerrainIntent('Alpine mountain range with rivers, erosion, snow coverage, and detailed texturing');
    const simple = analyzeTerrainIntent('Simple mountain');
    expect(intent.estimatedNodeCount).toBeGreaterThan(simple.estimatedNodeCount);
  });
});

describe('computeComplexityScore', () => {
  it('scores a simple linear graph low', () => {
    const nodes = [
      { id: 'a', type: 'Mountain', params: {} },
      { id: 'b', type: 'Erosion2', params: {} },
    ];
    const edges = [
      { from: 'a', fromPort: 'Out', to: 'b', toPort: 'In' },
    ];
    const score = computeComplexityScore(nodes, edges);
    expect(score).toBeLessThan(5);
  });

  it('scores a branching graph with merge higher', () => {
    const nodes = [
      { id: 'a', type: 'Mountain', params: {} },
      { id: 'b', type: 'Perlin', params: {} },
      { id: 'c', type: 'Erosion2', params: {} },
      { id: 'd', type: 'Snow', params: {} },
      { id: 'e', type: 'Combine', params: {} },
      { id: 'f', type: 'TextureBase', params: {} },
    ];
    const edges = [
      { from: 'a', fromPort: 'Out', to: 'c', toPort: 'In' },
      { from: 'b', fromPort: 'Out', to: 'd', toPort: 'In' },
      { from: 'c', fromPort: 'Out', to: 'e', toPort: 'In' },
      { from: 'd', fromPort: 'Out', to: 'e', toPort: 'Input2' },
      { from: 'e', fromPort: 'Out', to: 'f', toPort: 'In' },
    ];
    const score = computeComplexityScore(nodes, edges);
    expect(score).toBeGreaterThan(10);
  });
});
