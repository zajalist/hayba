import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  evaluate, assembleVerdict, bindingMatches, PRIMITIVES, primitivesById,
  polygonMargin, bakeProfile,
  upsertConstraint, loadConstraints, removeConstraint, validateConstraint,
  setConstraintsPath, putProfile, getProfile, annotateProfile, setProfilesPath, profileMap,
  identityTransform, addMask, getMask, removeMask,
  type Constraint, type InstanceState, type Profile,
} from './index.js';

function inst(object: string, pos: [number, number, number], opts: Partial<InstanceState> = {}): InstanceState {
  return { object, transform: { ...identityTransform(), pos }, ...opts };
}

describe('closed primitive set', () => {
  it('has exactly 11 primitives with unique ids and valid gates', () => {
    expect(PRIMITIVES.length).toBe(11);
    const ids = new Set(PRIMITIVES.map(p => p.id));
    expect(ids.size).toBe(11);
    const gates = new Set(['collision', 'stability', 'constraints', 'reach']);
    for (const p of PRIMITIVES) expect(gates.has(p.gate)).toBe(true);
  });

  it('qualitative primitives are facing + affordance_clear', () => {
    const q = PRIMITIVES.filter(p => p.qualitative).map(p => p.id).sort();
    expect(q).toEqual(['affordance_clear', 'facing']);
  });
});

describe('polygonMargin', () => {
  const square: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  it('is positive inside, negative outside', () => {
    expect(polygonMargin(square, [0, 0])).toBeCloseTo(1, 5);
    expect(polygonMargin(square, [2, 0])).toBeLessThan(0);
  });
});

describe('grounded primitive', () => {
  const prim = primitivesById().get('grounded')!;
  it('flags a floating instance and proposes a downward fix', () => {
    const profile: Profile = bakeProfile({ asset_id: '/Game/Tree', origin_cm: [0, 0, 380], extent_cm: [100, 100, 380], pivot_to_base_cm: -380 }, 'now');
    // pivot at z=5m → base at 5 + (-3.8) = 1.2m off the ground
    const i = inst('tree0', [0, 0, 5], { asset: '/Game/Tree' });
    const out = prim.evaluate({ constraint: { id: 'g', primitive: 'grounded', params: { tolerance_m: 0.05 }, binding: { asset: '/Game/Tree' } }, instance: i, profile, scene: { instances: [i] } });
    expect(out.value_m).toBeLessThan(0);
    expect(out.fix!.translate[2]).toBeCloseTo(-1.2, 5);
  });
  it('passes when seated (pivot at +3.8m → base at 0)', () => {
    const profile: Profile = bakeProfile({ asset_id: '/Game/Tree', origin_cm: [0, 0, 380], extent_cm: [100, 100, 380], pivot_to_base_cm: -380 }, 'now');
    const i = inst('tree0', [0, 0, 3.8], { asset: '/Game/Tree' });
    const out = prim.evaluate({ constraint: { id: 'g', primitive: 'grounded', params: {}, binding: { asset: '/Game/Tree' } }, instance: i, profile, scene: { instances: [i] } });
    expect(out.value_m).toBeGreaterThanOrEqual(0);
  });
});

describe('clearance primitive', () => {
  const prim = primitivesById().get('clearance')!;
  it('fails when two instances are closer than min_m and pushes apart', () => {
    const a = inst('a', [0, 0, 0]);
    const b = inst('b', [1, 0, 0]);
    const out = prim.evaluate({ constraint: { id: 'c', primitive: 'clearance', params: { min_m: 3 }, binding: { asset: 'x' } }, instance: a, profile: null, scene: { instances: [a, b] } });
    expect(out.value_m).toBeCloseTo(-2, 5);
    expect(out.fix!.translate[0]).toBeLessThan(0); // pushed away from b (+x)
  });
  it('skips when no other instances match', () => {
    const a = inst('a', [0, 0, 0]);
    const out = prim.evaluate({ constraint: { id: 'c', primitive: 'clearance', params: { min_m: 3 }, binding: { asset: 'x' } }, instance: a, profile: null, scene: { instances: [a] } });
    expect(out.skip).toBe(true);
  });
});

describe('surface_contact primitive', () => {
  const prim = primitivesById().get('surface_contact')!;
  it('passes when a surface is within the gap and fails when too far', () => {
    const a = inst('door', [0, 0, 0]);
    const near = inst('wall', [0.05, 0, 0]);
    const far = inst('wall', [3, 0, 0]);
    const pass = prim.evaluate({ constraint: { id: 's', primitive: 'surface_contact', params: { max_gap_m: 0.1 }, binding: { asset: 'x' } }, instance: a, profile: null, scene: { instances: [a, near] } });
    expect(pass.value_m).toBeGreaterThanOrEqual(0);
    const fail = prim.evaluate({ constraint: { id: 's', primitive: 'surface_contact', params: { max_gap_m: 0.1 }, binding: { asset: 'x' } }, instance: a, profile: null, scene: { instances: [a, far] } });
    expect(fail.value_m).toBeLessThan(0);
    expect(fail.fix!.translate[0]).toBeGreaterThan(0); // pulled toward the wall (+x)
  });
  it('skips when no candidate surfaces match', () => {
    const a = inst('door', [0, 0, 0]);
    const out = prim.evaluate({ constraint: { id: 's', primitive: 'surface_contact', params: {}, binding: { asset: 'x' } }, instance: a, profile: null, scene: { instances: [a] } });
    expect(out.skip).toBe(true);
  });
});

describe('Verdict assembly + gate ordering', () => {
  it('stops at collision before stability (hard short-circuit order)', () => {
    const v = assembleVerdict([
      { name: 'c1', primitive: 'clearance', ok: false, hard: true, magnitude: 2, value_m: -2 },
      { name: 's1', primitive: 'grounded', ok: false, hard: true, magnitude: 1, value_m: -1 },
    ]);
    expect(v.ok).toBe(false);
    expect(v.stopped_at).toBe('collision');
  });

  it('soft failures never block but accumulate soft_cost', () => {
    const v = assembleVerdict([
      { name: 'f1', primitive: 'facing', ok: false, hard: false, magnitude: 0.5, value_m: -0.5 },
    ]);
    expect(v.ok).toBe(true);
    expect(v.stopped_at).toBe(null);
    expect(v.soft_cost).toBeCloseTo(0.5, 5);
  });

  it('all-pass yields ok with no stopped gate', () => {
    const v = assembleVerdict([
      { name: 'c', primitive: 'clearance', ok: true, hard: true, magnitude: 0, value_m: 1.5 },
    ]);
    expect(v.ok).toBe(true);
    expect(v.stopped_at).toBe(null);
  });
});

describe('qualitative lock gating', () => {
  it('unlocked facing cannot hard-gate even when constraint.hard=true', () => {
    const profile = bakeProfile({ asset_id: '/Game/Statue', origin_cm: [0, 0, 0], extent_cm: [50, 50, 100] }, 'now');
    const profiles = new Map([['/Game/Statue', profile]]);
    const statue = inst('s', [0, 0, 0], { asset: '/Game/Statue' });
    const altar = inst('altar', [0, 10, 0]); // front is +X, target is +Y → 90° off-axis
    const c: Constraint = { id: 'face_altar', primitive: 'facing', params: { max_deg: 10 }, binding: { asset: '/Game/Statue' }, hard: true };
    const v = evaluate([statue, altar], [c], { profiles });
    expect(v.ok).toBe(true);                  // unlocked semantics → soft → cannot block
    expect(v.soft_cost).toBeGreaterThan(0);
  });

  it('locked facing CAN hard-gate', () => {
    let profile = bakeProfile({ asset_id: '/Game/Statue2', origin_cm: [0, 0, 0], extent_cm: [50, 50, 100] }, 'now');
    profile = { ...profile, provenance: { ...profile.provenance, locked: ['semantics.front'] } };
    const profiles = new Map([['/Game/Statue2', profile]]);
    const statue = inst('s', [0, 0, 0], { asset: '/Game/Statue2' });
    const altar = inst('altar', [0, 10, 0]);
    const c: Constraint = { id: 'face2', primitive: 'facing', params: { max_deg: 10 }, binding: { asset: '/Game/Statue2' }, hard: true };
    const v = evaluate([statue, altar], [c], { profiles });
    expect(v.ok).toBe(false);
    expect(v.stopped_at).toBe('constraints');
  });
});

describe('constraint store + validation', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plumb-')); setConstraintsPath(join(dir, 'c.json')); setProfilesPath(join(dir, 'p.json')); });
  afterEach(() => { setConstraintsPath(null); setProfilesPath(null); rmSync(dir, { recursive: true, force: true }); });

  it('rejects unknown primitive', () => {
    const errs = validateConstraint({ id: 'x', primitive: 'teleport', params: {}, binding: { asset: '/Game/A' } });
    expect(errs.some(e => e.field === 'primitive')).toBe(true);
  });
  it('rejects binding with both asset and tag', () => {
    const errs = validateConstraint({ id: 'x', primitive: 'grounded', params: {}, binding: { asset: '/Game/A', tag: { axis: 'a', value: 'b' } } });
    expect(errs.some(e => e.field === 'binding')).toBe(true);
  });
  it('rejects unknown params for the primitive', () => {
    const errs = validateConstraint({ id: 'x', primitive: 'grounded', params: { nonsense: 1 }, binding: { asset: '/Game/A' } });
    expect(errs.some(e => e.field === 'params.nonsense')).toBe(true);
  });
  it('upserts and removes a valid constraint', () => {
    const c: Constraint = { id: 'tree_grounded', primitive: 'grounded', params: { tolerance_m: 0.05 }, binding: { asset: '/Game/Tree' } };
    expect(upsertConstraint(c).ok).toBe(true);
    expect(loadConstraints().length).toBe(1);
    expect(removeConstraint('tree_grounded')).toBe(true);
    expect(loadConstraints().length).toBe(0);
  });
});

describe('profile store + bake + annotate', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plumb-')); setProfilesPath(join(dir, 'p.json')); });
  afterEach(() => { setProfilesPath(null); rmSync(dir, { recursive: true, force: true }); });

  it('bake converts cm→m and persists', () => {
    const p = bakeProfile({ asset_id: '/Game/Rock', origin_cm: [0, 0, 50], extent_cm: [100, 100, 50] }, 'now');
    expect(p.geometry.aabb.max[2]).toBeCloseTo(1, 5);  // 100cm = 1m
    expect(p.structural.ground_offset_m).toBeCloseTo(-0.5, 5);
    putProfile(p);
    expect(getProfile('/Game/Rock')!.bake_version).toBe(1);
  });

  it('annotate merges semantics + records provenance lock', () => {
    putProfile(bakeProfile({ asset_id: '/Game/Door', origin_cm: [0, 0, 0], extent_cm: [50, 10, 100] }, 'now'));
    const merged = annotateProfile('/Game/Door', { front: [0, 1, 0], affordances: [{ id: 'swing', region: { center: [0, 0.5, 0], extents: [0.5, 0.5, 1] } }] }, { lock: ['semantics.front'] });
    expect(merged!.semantics.front).toEqual([0, 1, 0]);
    expect(merged!.provenance.locked).toContain('semantics.front');
    expect(merged!.provenance.auto).toBe(false);
  });

  it('annotate returns null with no base bake', () => {
    expect(annotateProfile('/Game/Nothing', { cls: 'x' })).toBe(null);
  });
});

describe('end-to-end: tag-bound grounded enforced across instances', () => {
  it('flags every tree instance off the ground', () => {
    const c: Constraint = { id: 'trees_grounded', primitive: 'grounded', params: { tolerance_m: 0.05 }, binding: { tag: { axis: 'kind', value: 'tree' } } };
    const profile = bakeProfile({ asset_id: '/Game/Tree', origin_cm: [0, 0, 380], extent_cm: [100, 100, 380], pivot_to_base_cm: -380 }, 'now');
    const profiles = new Map([['/Game/Tree', profile]]);
    const a = inst('t1', [0, 0, 5], { asset: '/Game/Tree', tags: { kind: 'tree' } });   // floating
    const b = inst('t2', [10, 0, 3.8], { asset: '/Game/Tree', tags: { kind: 'tree' } }); // seated
    const v = evaluate([a, b], [c], { profiles });
    const stability = v.gates.find(g => g.gate === 'stability')!;
    expect(stability.constraints.length).toBe(2);
    expect(stability.constraints.filter(r => !r.ok).length).toBe(1);
    expect(v.ok).toBe(false);
  });

  it('bindingMatches respects asset vs tag', () => {
    const byAsset: Constraint = { id: 'a', primitive: 'grounded', params: {}, binding: { asset: '/Game/Tree' } };
    expect(bindingMatches(byAsset, inst('x', [0, 0, 0], { asset: '/Game/Tree' }))).toBe(true);
    expect(bindingMatches(byAsset, inst('x', [0, 0, 0], { asset: '/Game/Rock' }))).toBe(false);
  });
});

describe('mask store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mask-')); setProfilesPath(join(dir, 'p.json')); putProfile(bakeProfile({ asset_id: '/Game/Door', origin_cm: [0,0,0], extent_cm: [50,10,100] }, 'now')); });
  afterEach(() => { setProfilesPath(null); rmSync(dir, { recursive: true, force: true }); });

  it('adds, gets and removes a volume mask', () => {
    const m = { id: 'swing_front', type: 'volume' as const, color: '#48f', source: 'ai' as const, confidence: 0.8, locked: false, shape: { kind: 'box' as const, transform: identityTransform(), extents: [1,1,2] as [number,number,number] } };
    expect(addMask('/Game/Door', m)!.masks!.length).toBe(1);
    expect(getMask('/Game/Door', 'swing_front')!.type).toBe('volume');
    expect(removeMask('/Game/Door', 'swing_front')).toBe(true);
    expect(getMask('/Game/Door', 'swing_front')).toBe(null);
  });
  it('addMask returns null with no base profile', () => {
    expect(addMask('/Game/Nope', { id: 'x', type: 'surface', color: '#fff', source: 'human', confidence: 1, locked: false, triangles: [1,2,3] })).toBe(null);
  });
});

describe('mask-referencing primitives', () => {
  it('inside_outside resolves a volume mask region from the profile', () => {
    let profile = bakeProfile({ asset_id: '/Game/Zone', origin_cm: [0,0,0], extent_cm: [10,10,10] }, 'now');
    profile = { ...profile, masks: [{ id: 'keep_in', type: 'volume', color: '#0f0', source: 'human', confidence: 1, locked: true, shape: { kind: 'box', transform: { pos: [0,0,0], quat: [0,0,0,1], scale: [1,1,1] }, extents: [2,2,2] } }] };
    const prim = primitivesById().get('inside_outside')!;
    const inside = prim.evaluate({ constraint: { id: 'c', primitive: 'inside_outside', params: { mask: 'keep_in', mode: 'inside' }, binding: { asset: '/Game/Zone' } }, instance: { object: 'p', asset: '/Game/Zone', transform: { pos: [0,0,0], quat: [0,0,0,1], scale: [1,1,1] } }, profile, scene: { instances: [] } });
    expect(inside.value_m).toBeCloseTo(2, 5);   // at centre, inside the 2m box → margin = 2m
  });

  it('inside_outside falls back to inline center/extents when mask is absent (back-compat)', () => {
    const profile = bakeProfile({ asset_id: '/Game/Zone', origin_cm: [0,0,0], extent_cm: [10,10,10] }, 'now');
    const prim = primitivesById().get('inside_outside')!;
    const inside = prim.evaluate({ constraint: { id: 'c', primitive: 'inside_outside', params: { center: [0, 0, 0], extents: [2, 2, 2], mode: 'inside' }, binding: { asset: '/Game/Zone' } }, instance: { object: 'p', asset: '/Game/Zone', transform: { pos: [0,0,0], quat: [0,0,0,1], scale: [1,1,1] } }, profile, scene: { instances: [] } });
    expect(inside.value_m).toBeCloseTo(2, 5);   // same result without mask parameter
  });
});
