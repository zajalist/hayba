import { describe, it, expect } from 'vitest';
import { matchProductions, expandGrammar } from './grammar.js';
import type { Production, Symbol } from './contracts.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The productions used to be read from D:/UnrealEngine/template/.scratch/grammar.json
// — an absolute path on one developer's machine. That made this suite pass
// locally and fail on every CI runner with ENOENT, permanently, which is worse
// than having no test: a red check everyone learns to ignore stops reporting
// anything at all.
//
// The fixture is committed instead. It is 5 productions and under 2KB, and it
// is the input the assertions below are written against, so it belongs with
// them rather than in a scratch directory that can be cleared at any time.
const __dirname = dirname(fileURLToPath(import.meta.url));
const roomProds = JSON.parse(
  readFileSync(join(__dirname, '__fixtures__', 'room-grammar.json'), 'utf8'),
) as Record<string, Production>;

const prods = Object.values(roomProds) as Production[];
const noGuards = () => ({ hardFail: false, softFails: [] });

describe('room productions', () => {
  it('an imperial room seed matches P_room_imperial and emits a room shell', () => {
    const seed: Symbol = { kind: 'room', attrs: { builder: 'imperial', phase: 'II', w: 6, h: 3.5 } } as Symbol;
    const matched = matchProductions(seed, prods);
    expect(matched.some(p => p.id === 'P_room_imperial')).toBe(true);
    const plan = expandGrammar(seed, prods, noGuards);
    expect(plan.items.some(i => i.kind === 'shell' && i.role === 'room')).toBe(true);
  });
  it('a native room seed matches P_room_native', () => {
    const seed: Symbol = { kind: 'room', attrs: { builder: 'native' } } as Symbol;
    expect(matchProductions(seed, prods).some(p => p.id === 'P_room_native')).toBe(true);
  });
});
