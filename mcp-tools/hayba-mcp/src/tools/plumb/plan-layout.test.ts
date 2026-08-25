import { describe, it, expect } from 'vitest';
import {
  perimeterPoints, wallMidpoints, interiorPoints, anchorOf, pointsFor,
  type RoomFootprint,
} from './plan-layout.js';

const room: RoomFootprint = { w: 6, h: 4, center_cm: [0, 0, 0] };

describe('perimeter placement', () => {
  it('walks the whole rectangle, not one wall', () => {
    const pts = perimeterPoints(room, 2);

    const xs = pts.map((p) => p.loc_cm[0]);
    const ys = pts.map((p) => p.loc_cm[1]);
    expect(Math.min(...xs)).toBeCloseTo(-300, 0);
    expect(Math.max(...xs)).toBeCloseTo(300, 0);
    expect(Math.min(...ys)).toBeCloseTo(-200, 0);
    expect(Math.max(...ys)).toBeCloseTo(200, 0);
  });

  it('keeps every point on the boundary', () => {
    for (const p of perimeterPoints(room, 1.5)) {
      const onX = Math.abs(Math.abs(p.loc_cm[0]) - 300) < 1;
      const onY = Math.abs(Math.abs(p.loc_cm[1]) - 200) < 1;
      // A column that drifts inside the room is furniture, not a colonnade.
      expect(onX || onY).toBe(true);
    }
  });

  it('puts more columns on a longer wall', () => {
    const wide: RoomFootprint = { w: 20, h: 4, center_cm: [0, 0, 0] };
    expect(perimeterPoints(wide, 2).length).toBeGreaterThan(perimeterPoints(room, 2).length);
  });

  it('alternate halves the run, which is what the grammar means by it', () => {
    const all = perimeterPoints(room, 1);
    const alt = perimeterPoints(room, 1, true);
    expect(alt.length).toBe(Math.ceil(all.length / 2));
  });

  it('faces each wall inward', () => {
    const yaws = new Set(perimeterPoints(room, 3).map((p) => p.yaw_deg));
    expect(yaws.size).toBeGreaterThan(1);
  });
});

describe('wall midpoints', () => {
  it('gives exactly four, one per wall', () => {
    const mids = wallMidpoints(room);
    expect(mids).toHaveLength(4);
    expect(mids.map((m) => m.yaw_deg).sort((a, b) => a - b)).toEqual([0, 90, 180, 270]);
  });

  it('sits on the walls of the room it was given', () => {
    const off: RoomFootprint = { w: 6, h: 4, center_cm: [1000, 500, 0] };
    const mids = wallMidpoints(off);
    expect(mids[0]!.loc_cm).toEqual([1000, 300, 0]);
  });
});

describe('interior scatter', () => {
  it('stays inside the room', () => {
    for (const p of interiorPoints(room, 40, 7)) {
      expect(Math.abs(p.loc_cm[0])).toBeLessThan(300);
      expect(Math.abs(p.loc_cm[1])).toBeLessThan(200);
    }
  });

  it('is the same room twice for the same seed', () => {
    expect(interiorPoints(room, 5, 42)).toEqual(interiorPoints(room, 5, 42));
  });

  it('is a different room for a different seed', () => {
    expect(interiorPoints(room, 5, 1)).not.toEqual(interiorPoints(room, 5, 2));
  });
});

describe('what it refuses to place', () => {
  it('will not fake an anchor that needs a shell', () => {
    // A crack decal on an arch crown, placed at floor height, is not a near
    // miss -- it is in the wrong place and looks like a bug in the art.
    const r = pointsFor({ emit: 'decal', role: 'crack', along: 'arch_crown' }, room);
    expect(r.points).toEqual([]);
    expect(r.unresolved).toMatch(/no shell is built yet/);
  });

  it('will not guess at an anchor it does not know', () => {
    const r = pointsFor({ emit: 'asset', role: 'x', at: 'ceiling_boss' }, room);
    expect(r.points).toEqual([]);
    expect(r.unresolved).toMatch(/not one this layout knows/);
  });

  it('treats an unanchored item as interior', () => {
    expect(anchorOf({ emit: 'scatter', tag: 'rubble' })).toBe('interior');
  });
});

describe('resolving a real grammar item', () => {
  it('spaces a column run along the floor edge', () => {
    const r = pointsFor(
      { emit: 'asset', role: 'column', along: 'floor_edge', spacing_m: 2.5, alternate: true },
      room,
    );
    expect(r.unresolved).toBeUndefined();
    expect(r.points.length).toBeGreaterThan(0);
  });

  it('puts a vent at each wall middle', () => {
    const r = pointsFor({ emit: 'asset', role: 'vent', at: 'wall_mid' }, room);
    expect(r.points).toHaveLength(4);
  });
});
