import { describe, it, expect } from 'vitest';
import { parseBiomePrompt, makeRng, planScatter, validateAndFix, type Placement } from './world-generate.js';
import { bakeProfile } from '../../plumb/index.js';
import type { Constraint, Profile } from '../../plumb/contracts.js';

describe('parseBiomePrompt', () => {
  it('extracts the layers and the exact nouns mentioned', () => {
    const layers = parseBiomePrompt('Lakeside hemlock forest with dense fern undergrowth, boulders and mossy branches');
    const roles = layers.map((l) => l.role).sort();
    expect(roles).toEqual(['canopy', 'groundcover', 'rock', 'undergrowth']);
    const canopy = layers.find((l) => l.role === 'canopy')!;
    expect(canopy.keywords).toContain('hemlock');
    expect(layers.find((l) => l.role === 'rock')!.keywords).toContain('boulders');
  });

  it('returns no layers for an unrelated prompt', () => {
    expect(parseBiomePrompt('a shiny metal robot')).toEqual([]);
  });
});

describe('makeRng', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRng(42); const b = makeRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('planScatter', () => {
  const layers = parseBiomePrompt('pine trees and ferns and boulders');
  const assets = { canopy: '/Game/T_Pine', undergrowth: '/Game/T_Fern', rock: '/Game/T_Rock' };

  it('is deterministic and only places layers with a resolved asset', () => {
    const p1 = planScatter(layers, assets, [0, 0, 0], 1000, 30, 7);
    const p2 = planScatter(layers, assets, [0, 0, 0], 1000, 30, 7);
    expect(p1).toEqual(p2);
    expect(p1.every((p) => Object.values(assets).includes(p.asset))).toBe(true);
  });

  it('skips a layer whose asset is missing', () => {
    const p = planScatter(layers, { canopy: '/Game/T_Pine' }, [0, 0, 0], 1000, 20, 1);
    expect(p.every((x) => x.role === 'canopy')).toBe(true);
  });

  it('keeps instances within the radius', () => {
    const p = planScatter(layers, assets, [500, 500, 0], 1000, 40, 3);
    for (const x of p) {
      const dx = x.loc_cm[0] - 500, dy = x.loc_cm[1] - 500;
      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(1000.0001);
    }
  });
});

describe('validateAndFix', () => {
  it('skips when no constraints/profiles', () => {
    const placements: Placement[] = [{ object: 'a', asset: '/Game/X', role: 'rock', loc_cm: [0, 0, 0], yaw_deg: 0, scale: 1 }];
    const v = validateAndFix(placements, [], new Map());
    expect(v.ran).toBe(false);
  });

  it('grounds floating instances by applying PLUMB fix vectors', () => {
    // Profile: 1m cube, base at bottom (pivot-to-base = -50cm). A tree placed 5m
    // up should fail grounded and get pulled down to the ground plane.
    const asset = '/Game/T_Pine';
    const profile: Profile = bakeProfile({ asset_id: asset, origin_cm: [0, 0, 50], extent_cm: [50, 50, 50] }, '1970-01-01T00:00:00.000Z');
    const profiles = new Map<string, Profile>([[asset, profile]]);
    const constraints: Constraint[] = [{ id: 'g', primitive: 'grounded', params: { tolerance_m: 0.1 }, binding: { asset } }];

    const placements: Placement[] = [{ object: 'tree0', asset, role: 'canopy', loc_cm: [0, 0, 500], yaw_deg: 0, scale: 1 }];
    const v = validateAndFix(placements, constraints, profiles);

    expect(v.ran).toBe(true);
    expect(v.failed_before).toBe(1);
    expect(v.failed_after).toBe(0);
    expect(v.fixed).toBeGreaterThan(0);
    // corrected downward from the 5m float
    expect(placements[0].loc_cm[2]).toBeLessThan(500);
  });
});
