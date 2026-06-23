import { describe, it, expect } from 'vitest';
import { matchProductions, expandGrammar } from './grammar.js';
import type { GuardFn } from './grammar.js';

const passAll: GuardFn = () => ({ hardFail: false, softFails: [] });

describe('matchProductions', () => {
  it('sorts by priority desc and filters by kind + when', () => {
    const prods = [
      { id: 'A', lhs: { kind: 'tunnel' }, rhs: [{ emit: 'shell', role: 'wall' }], guards: [], priority: 10 },
      { id: 'B', lhs: { kind: 'tunnel', when: { builder: 'native' } }, rhs: [{ emit: 'shell', role: 'wall' }], guards: [], priority: 50 },
      { id: 'C', lhs: { kind: 'room' }, rhs: [{ emit: 'shell', role: 'wall' }], guards: [], priority: 99 },
    ];
    expect(matchProductions({ kind: 'tunnel', attrs: { builder: 'native' } } as any, prods as any).map(p => p.id)).toEqual(['B', 'A']);
  });
});

describe('expandGrammar', () => {
  it('emits first satisfied production and stops', () => {
    const prods = [{ id: 'A', lhs: { kind: 'tunnel' }, rhs: [{ emit: 'asset', role: 'column' }], guards: [], priority: 1 }];
    expect(expandGrammar({ kind: 'tunnel', attrs: {} } as any, prods as any, passAll).items.map(i => i.role)).toEqual(['column']);
  });

  it('falls back to next production when a guard hard-fails', () => {
    const prods = [
      { id: 'straight', lhs: { kind: 'shaft' }, rhs: [{ emit: 'shell', role: 'vent' }], guards: ['no_straight_air_over_6m'], priority: 50 },
      { id: 'bent', lhs: { kind: 'shaft' }, rhs: [{ emit: 'shell', role: 'vent', bend_at_m: 5 }], guards: [], priority: 10 },
    ];
    const guards: GuardFn = (ids) => ({ hardFail: ids.includes('no_straight_air_over_6m'), softFails: [] });
    const plan = expandGrammar({ kind: 'shaft', attrs: {} } as any, prods as any, guards);
    expect(plan.rejected).toContain('straight');
    expect(plan.items[0].meta.bend_at_m).toBe(5);
  });

  it('recurses into child symbols', () => {
    const prods = [
      { id: 'air', lhs: { kind: 'tunnel' }, rhs: [{ emit: 'asset', role: 'vent' }, { emit: 'symbol', kind: 'shaft', len: 5 }], guards: [], priority: 50 },
      { id: 'bent', lhs: { kind: 'shaft' }, rhs: [{ emit: 'shell', role: 'vent', bend_at_m: 5 }], guards: [], priority: 10 },
    ];
    expect(expandGrammar({ kind: 'tunnel', attrs: {} } as any, prods as any, passAll).items.map(i => i.role)).toEqual(['vent', 'vent']);
  });

  it('is deterministic across runs', () => {
    const prods = [{ id: 'A', lhs: { kind: 'tunnel' }, rhs: [{ emit: 'asset', role: 'column' }], guards: [], priority: 1 }];
    const a = expandGrammar({ kind: 'tunnel', attrs: {} } as any, prods as any, passAll);
    const b = expandGrammar({ kind: 'tunnel', attrs: {} } as any, prods as any, passAll);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
