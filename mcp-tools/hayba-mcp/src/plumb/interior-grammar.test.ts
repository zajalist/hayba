import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandGrammar } from './grammar.js';
import type { Production, Symbol } from './contracts.js';
import { pointsFor } from '../tools/plumb/plan-layout.js';

// The room productions emit a shell, some scatter and a floor fill, which is a
// room-shaped hole rather than an interior. These productions answer the
// question A7 is actually about.
//
// The binding constraint is that every anchor they use must be one
// plan-layout.ts can resolve. A grammar that promises what the executor cannot
// place is the same dead end as a tool nothing calls, so that is asserted here
// rather than left to be discovered in an editor.

const here = dirname(fileURLToPath(import.meta.url));
const prods = Object.values(
  JSON.parse(readFileSync(join(here, 'starter-grammar.json'), 'utf8')) as Record<string, Production>,
);
const noGuards = () => ({ hardFail: false, softFails: [] });
const ROOM = { w: 8, h: 6, center_cm: [0, 0, 0] as [number, number, number] };

const expand = (attrs: Record<string, unknown>) =>
  expandGrammar({ kind: 'interior', attrs } as Symbol, prods, noGuards);

describe('a hall', () => {
  const plan = expand({ use: 'hall', builder: 'imperial' });
  const roles = plan.items.map((i) => i.role ?? i.tag);

  it('has a way in, light, somewhere to sit and signs of life', () => {
    expect(roles).toContain('door');
    expect(roles).toContain('sconce');
    expect(roles).toContain('table');
    expect(roles).toContain('chair');
    expect(roles).toContain('clutter');
  });

  it('gets its seating through a symbol, not by repeating the detail', () => {
    const seating = plan.items.filter((i) => i.symbolKind === 'seating');
    expect(seating.map((i) => i.role).sort()).toEqual(['chair', 'table']);
  });
});

describe('a store room', () => {
  const plan = expand({ use: 'store' });
  const roles = plan.items.map((i) => i.role ?? i.tag);

  it('is shelves and crates, not tables and chairs', () => {
    expect(roles).toContain('shelf');
    expect(roles).toContain('crate');
    expect(roles).not.toContain('table');
  });
});

describe('an interior with no use named', () => {
  it('still gives a usable room rather than nothing', () => {
    const roles = expand({}).items.map((i) => i.role ?? i.tag);
    expect(roles).toContain('door');
  });

  it('loses to a named use', () => {
    const roles = expand({ use: 'store' }).items.map((i) => i.role ?? i.tag);
    expect(roles).toContain('shelf');
  });
});

describe('everything the interior grammar emits can actually be placed', () => {
  it('resolves every anchor the executor will be handed', () => {
    for (const use of ['hall', 'store', undefined]) {
      const plan = expand(use ? { use } : {});
      for (const item of plan.items) {
        // shell and fill are refused by the executor on purpose; those are the
        // known gap. Everything else must resolve to real points.
        if (item.kind === 'shell' || item.kind === 'fill' || item.kind === 'decal') continue;
        const r = pointsFor(item.meta as Record<string, unknown>, ROOM);
        expect(r.unresolved, `${use ?? 'default'} / ${item.role ?? item.tag}`).toBeUndefined();
        expect(r.points.length).toBeGreaterThan(0);
      }
    }
  });

  it('puts the door on a wall and the furniture inside', () => {
    const plan = expand({ use: 'hall' });
    const door = plan.items.find((i) => i.role === 'door')!;
    const table = plan.items.find((i) => i.role === 'table')!;

    const doorPts = pointsFor(door.meta as Record<string, unknown>, ROOM).points;
    const tablePts = pointsFor(table.meta as Record<string, unknown>, ROOM).points;

    // A door in the middle of the floor is not a door.
    for (const p of doorPts) {
      const onWall = Math.abs(Math.abs(p.loc_cm[0]) - 400) < 1 || Math.abs(Math.abs(p.loc_cm[1]) - 300) < 1;
      expect(onWall).toBe(true);
    }
    for (const p of tablePts) {
      expect(Math.abs(p.loc_cm[0])).toBeLessThan(400);
      expect(Math.abs(p.loc_cm[1])).toBeLessThan(300);
    }
  });
});
