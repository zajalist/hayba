import { describe, it, expect } from 'vitest';
import { layoutGraph, LAYOUT } from './layout-engine.js';

describe('layoutGraph', () => {
  it('positions a simple linear chain left-to-right', () => {
    const nodes = [
      { id: 'mountain', type: 'Mountain', params: {} },
      { id: 'erode', type: 'Erosion2', params: {} },
      { id: 'snow', type: 'Snow', params: {} },
    ];
    const edges = [
      { from: 'mountain', fromPort: 'Out', to: 'erode', toPort: 'In' },
      { from: 'erode', fromPort: 'Out', to: 'snow', toPort: 'In' },
    ];
    const result = layoutGraph(nodes, edges);

    // Mountain should be leftmost
    expect(result[0].id).toBe('mountain');
    expect(result[0].position.X).toBe(LAYOUT.ORIGIN_X);

    // Each subsequent node 300px to the right
    expect(result[1].position.X).toBe(LAYOUT.ORIGIN_X + LAYOUT.H_SPACING);
    expect(result[2].position.X).toBe(LAYOUT.ORIGIN_X + LAYOUT.H_SPACING * 2);

    // All on the same Y (single chain, no branching)
    expect(result[0].position.Y).toBe(LAYOUT.ORIGIN_Y);
    expect(result[1].position.Y).toBe(LAYOUT.ORIGIN_Y);
    expect(result[2].position.Y).toBe(LAYOUT.ORIGIN_Y);
  });

  it('stacks parallel generators vertically at same X', () => {
    const nodes = [
      { id: 'peak1', type: 'Mountain', params: {} },
      { id: 'peak2', type: 'Mountain', params: {} },
      { id: 'combine', type: 'Combine', params: {} },
    ];
    const edges = [
      { from: 'peak1', fromPort: 'Out', to: 'combine', toPort: 'In' },
      { from: 'peak2', fromPort: 'Out', to: 'combine', toPort: 'Input2' },
    ];
    const result = layoutGraph(nodes, edges);

    // Both generators should be at the same X (layer 0)
    const peak1 = result.find(n => n.id === 'peak1')!;
    const peak2 = result.find(n => n.id === 'peak2')!;
    expect(peak1.position.X).toBe(peak2.position.X);

    // They should be at different Y positions
    expect(peak1.position.Y).not.toBe(peak2.position.Y);
    expect(Math.abs(peak1.position.Y - peak2.position.Y)).toBe(LAYOUT.V_SPACING);
  });

  it('places Combine node at median Y of its inputs', () => {
    const nodes = [
      { id: 'a', type: 'Mountain', params: {} },
      { id: 'b', type: 'Perlin', params: {} },
      { id: 'c', type: 'Combine', params: {} },
    ];
    const edges = [
      { from: 'a', fromPort: 'Out', to: 'c', toPort: 'In' },
      { from: 'b', fromPort: 'Out', to: 'c', toPort: 'Input2' },
    ];
    const result = layoutGraph(nodes, edges);
    const a = result.find(n => n.id === 'a')!;
    const b = result.find(n => n.id === 'b')!;
    const c = result.find(n => n.id === 'c')!;

    const medianY = (a.position.Y + b.position.Y) / 2;
    expect(c.position.Y).toBe(medianY);
  });

  it('handles a diamond DAG without crashing', () => {
    const nodes = [
      { id: 'src', type: 'Mountain', params: {} },
      { id: 'left', type: 'Erosion2', params: {} },
      { id: 'right', type: 'Snow', params: {} },
      { id: 'merge', type: 'Combine', params: {} },
    ];
    const edges = [
      { from: 'src', fromPort: 'Out', to: 'left', toPort: 'In' },
      { from: 'src', fromPort: 'Out', to: 'right', toPort: 'In' },
      { from: 'left', fromPort: 'Out', to: 'merge', toPort: 'In' },
      { from: 'right', fromPort: 'Out', to: 'merge', toPort: 'Input2' },
    ];
    const result = layoutGraph(nodes, edges);

    expect(result.length).toBe(4);

    const src = result.find(n => n.id === 'src')!;
    const left = result.find(n => n.id === 'left')!;
    const right = result.find(n => n.id === 'right')!;
    const merge = result.find(n => n.id === 'merge')!;

    // src at layer 0, left/right at layer 1, merge at layer 2
    expect(src.position.X).toBeLessThan(left.position.X);
    expect(left.position.X).toBe(right.position.X);
    expect(left.position.X).toBeLessThan(merge.position.X);
  });

  it('offsets lookdev phase nodes below main flow', () => {
    const nodes = [
      { id: 'mountain', type: 'Mountain', params: {}, phase: 'base' },
      { id: 'erode', type: 'Erosion2', params: {}, phase: 'simulation' },
      { id: 'texbase', type: 'TextureBase', params: {}, phase: 'lookdev' },
    ];
    const edges = [
      { from: 'mountain', fromPort: 'Out', to: 'erode', toPort: 'In' },
      { from: 'erode', fromPort: 'Out', to: 'texbase', toPort: 'In' },
    ];
    const nodeRef = {
      Mountain: { category: 'primitive', description: '', ports: { in: [], out: [] }, parameters: {}, tips: [], phase_hint: 'base', typical_predecessors: [], typical_successors: [], zone_strategy: 'none' as const, position_params: [] },
      Erosion2: { category: 'simulation', description: '', ports: { in: [], out: [] }, parameters: {}, tips: [], phase_hint: 'simulation', typical_predecessors: [], typical_successors: [], zone_strategy: 'none' as const, position_params: [] },
      TextureBase: { category: 'texture', description: '', ports: { in: [], out: [] }, parameters: {}, tips: [], phase_hint: 'lookdev', typical_predecessors: [], typical_successors: [], zone_strategy: 'none' as const, position_params: [] },
    };
    const result = layoutGraph(nodes, edges, nodeRef);

    const mountain = result.find(n => n.id === 'mountain')!;
    const texbase = result.find(n => n.id === 'texbase')!;

    // TextureBase (lookdev) should be offset below mountain (base)
    expect(texbase.position.Y).toBeGreaterThan(mountain.position.Y);
  });

  it('handles single node', () => {
    const result = layoutGraph(
      [{ id: 'solo', type: 'Mountain', params: {} }],
      [],
    );
    expect(result.length).toBe(1);
    expect(result[0].position.X).toBe(LAYOUT.ORIGIN_X);
    expect(result[0].position.Y).toBe(LAYOUT.ORIGIN_Y);
  });
});
