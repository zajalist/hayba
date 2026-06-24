import { describe, it, expect } from 'vitest';
import { matchProductions, expandGrammar } from './grammar.js';
import type { Production, Symbol } from './contracts.js';
import { readFileSync } from 'node:fs';
const roomProds = JSON.parse(readFileSync('D:/UnrealEngine/template/.scratch/grammar.json', 'utf8'));

const prods = Object.values(roomProds) as Production[];
const noGuards = () => ({ hardFail: false, softFails: [] });

describe('room productions', () => {
  it('an imperial room seed matches P_room_imperial and emits a room shell', () => {
    const seed: Symbol = { kind: 'room', attrs: { builder: 'imperial', phase: 'II', w: 6, h: 3.5 } } as Symbol;
    const matched = matchProductions(seed, prods);
    expect(matched.some(p => p.id === 'P_room_imperial')).toBe(true);
    const plan = expandGrammar(seed, prods, noGuards);
    expect(plan.items.some(i => i.emit === 'shell' && i.role === 'room')).toBe(true);
  });
  it('a native room seed matches P_room_native', () => {
    const seed: Symbol = { kind: 'room', attrs: { builder: 'native' } } as Symbol;
    expect(matchProductions(seed, prods).some(p => p.id === 'P_room_native')).toBe(true);
  });
});
