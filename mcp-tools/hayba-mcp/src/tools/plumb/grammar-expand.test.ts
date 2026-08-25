import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGrammarPath } from '../../plumb/grammar-store.js';
import { plumbGrammarExpandHandler } from './tools.js';

let dir: string;

const GRAMMAR = {
  P_room: {
    id: 'P_room', priority: 100, guards: [],
    lhs: { kind: 'room' },
    rhs: [{ emit: 'shell', role: 'room' }, { emit: 'scatter', tag: 'debris' }],
  },
  P_tunnel: {
    id: 'P_tunnel', priority: 100, guards: [],
    lhs: { kind: 'tunnel' },
    rhs: [{ emit: 'shell', role: 'wall' }],
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hayba-grammar-expand-'));
  const p = join(dir, 'grammar.json');
  writeFileSync(p, JSON.stringify(GRAMMAR), 'utf-8');
  setGrammarPath(p);
});

afterEach(() => {
  setGrammarPath(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('plumb_grammar_expand', () => {
  it('expands a known seed', async () => {
    const r = await plumbGrammarExpandHandler({ seed: { kind: 'room' } });
    const plan = r.plan as { items: unknown[] };

    expect(plan.items).toHaveLength(2);
  });

  it('names the vocabulary when the seed kind matches nothing', async () => {
    const r = await plumbGrammarExpandHandler({ seed: { kind: 'corridor' } });

    // An empty plan reads as "this produces nothing" rather than "nothing here
    // speaks that word". The difference decides whether a caller gives up.
    expect(r.note).toMatch(/knows: room, tunnel/);
    expect(r.note).toMatch(/corridor/);
    expect(r.known_symbol_kinds).toEqual(['room', 'tunnel']);
  });

  it('says outright that nothing was placed', async () => {
    const r = await plumbGrammarExpandHandler({ seed: { kind: 'room' } });

    // The reply is a list of things and where they go, which looks like a
    // result. No actor exists, and `role` is still an unbound label.
    expect(r.placed).toBe(false);
  });

  it('does not claim an unmatched vocabulary when items were produced', async () => {
    const r = await plumbGrammarExpandHandler({ seed: { kind: 'tunnel' } });
    expect(r.note).toMatch(/Expanded from seed/);
  });
});
