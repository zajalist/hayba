import { describe, it, expect } from 'vitest';
import { compileGraph, constraintsToGraph, type ConstraintGraph } from './graph.js';
import type { Constraint } from './index.js';

describe('constraint graph compile', () => {
  it('compiles a primitive node wired to a mask into a Constraint', () => {
    const g: ConstraintGraph = {
      nodes: [
        { id: 'm1', kind: 'mask', maskId: 'swing_front' },
        { id: 'p1', kind: 'primitive', primitive: 'clearance', params: { min_m: 0.9 }, hard: true },
        { id: 'v', kind: 'verdict' },
      ],
      edges: [{ from: 'm1', to: 'p1' }, { from: 'p1', to: 'v' }],
    };
    const cs = compileGraph(g, { asset: '/Game/Door' });
    expect(cs.length).toBe(1);
    expect(cs[0].primitive).toBe('clearance');
    expect(cs[0].params.mask).toBe('swing_front');
    expect(cs[0].params.min_m).toBe(0.9);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].binding.asset).toBe('/Game/Door');
  });

  it('round-trips flat constraints through constraintsToGraph -> compileGraph', () => {
    const flat: Constraint[] = [{ id: 'g', primitive: 'grounded', params: { tolerance_m: 0.05 }, binding: { asset: '/Game/Tree' } }];
    const g = constraintsToGraph(flat);
    const back = compileGraph(g, { asset: '/Game/Tree' });
    expect(back[0].primitive).toBe('grounded');
    expect(back[0].params.tolerance_m).toBe(0.05);
  });
});
