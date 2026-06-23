// grammar-guards.test.ts — TDD for addSocket (profile-store) + makeGuardFn
//
// HONEST TEST CHOICE (per brief): no UE scene is available, so geometry
// primitives (max_straight_run, presence, grounded, etc.) self-skip unless
// a real profile + scene context is injected.
//
// We therefore test two honest behaviours:
//   1. Unknown guard id (not in constraint store) → { hardFail: false, softFails: [] }
//   2. Known guard id whose primitive SKIPs (no profile/scene) → no failure
//   3. Known HARD constraint that genuinely FAILs in TS without UE → hardFail: true
//      (we use `grounded` with a deliberately bad z-position and an in-memory profile)
//
// addSocket: idempotent replace-by-id.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setProfilesPath, putProfile, getProfile, addSocket } from './profile-store.js';
import { bakeProfile } from './bake.js';
import { setConstraintsPath, upsertConstraint } from './constraint-store.js';
import { makeGuardFn } from './grammar-guards.js';
import type { Symbol } from './contracts.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'plumb-gg-'));
}

// ── addSocket tests ───────────────────────────────────────────────────────────

describe('addSocket', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
    setProfilesPath(join(dir, 'profiles.json'));
  });
  afterEach(() => {
    setProfilesPath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when the profile does not exist', () => {
    expect(() => addSocket('/Game/DoesNotExist', { id: 'floor', type: 'floor', frame: { pos: [0, 0, 0], quat: [0, 0, 0, 1] } }))
      .toThrow(/no profile/);
  });

  it('adds a socket to a baked profile', () => {
    const p = bakeProfile({ asset_id: '/Game/TestA', origin_cm: [0, 0, 100], extent_cm: [50, 50, 100] }, 'now');
    putProfile(p);

    addSocket('/Game/TestA', { id: 'floor_attach', type: 'floor', frame: { pos: [0, 0, 0], quat: [0, 0, 0, 1] } });

    const loaded = getProfile('/Game/TestA');
    expect(loaded?.semantics.sockets?.map(s => s.id)).toContain('floor_attach');
  });

  it('replaces a socket with the same id (idempotent — no duplicates)', () => {
    const p = bakeProfile({ asset_id: '/Game/TestB', origin_cm: [0, 0, 100], extent_cm: [50, 50, 100] }, 'now');
    putProfile(p);

    const sock = { id: 'top', type: 'ceiling' as const, frame: { pos: [0, 0, 1] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] } };
    addSocket('/Game/TestB', sock);
    addSocket('/Game/TestB', { ...sock, frame: { pos: [0, 0, 2], quat: [0, 0, 0, 1] } }); // same id, different pos

    const loaded = getProfile('/Game/TestB');
    const sockets = loaded?.semantics.sockets ?? [];
    // exactly one socket with id 'top'
    expect(sockets.filter(s => s.id === 'top').length).toBe(1);
    // the second (updated) position wins
    expect(sockets.find(s => s.id === 'top')?.frame.pos).toEqual([0, 0, 2]);
  });
});

// ── makeGuardFn tests ─────────────────────────────────────────────────────────

describe('makeGuardFn', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
    setConstraintsPath(join(dir, 'constraints.json'));
    setProfilesPath(join(dir, 'profiles.json'));
  });
  afterEach(() => {
    setConstraintsPath(null);
    setProfilesPath(null);
    rmSync(dir, { recursive: true, force: true });
  });

  const sym: Symbol = { kind: 'tunnel', attrs: {} };

  it('unknown guard id (not in constraint store) → no failure', () => {
    const guard = makeGuardFn();
    const result = guard(['nonexistent_guard'], [], sym);
    expect(result.hardFail).toBe(false);
    expect(result.softFails).toEqual([]);
  });

  it('empty guard list → no failure', () => {
    const guard = makeGuardFn();
    const result = guard([], [], sym);
    expect(result.hardFail).toBe(false);
    expect(result.softFails).toEqual([]);
  });

  it('known constraint whose primitive SKIPs in dry-run → no failure', () => {
    // max_straight_run needs geometry context it cannot get without a UE scene → SKIPs
    upsertConstraint({
      id: 'c_msr',
      primitive: 'max_straight_run',
      params: { max_m: 5 },
      binding: { asset: '/Game/TestX' },
      hard: true,
    });
    const guard = makeGuardFn();
    const result = guard(['c_msr'], [], { kind: 'tunnel', attrs: { asset: '/Game/TestX' } });
    // primitive SKIPs without real geometry → no failure
    expect(result.hardFail).toBe(false);
    expect(result.softFails).toEqual([]);
  });

  it('HARD grounded constraint that genuinely FAILs in TS → hardFail: true', () => {
    // Bake a profile and create a symbol/instance where the object floats 5m above ground.
    const profile = bakeProfile(
      { asset_id: '/Game/FloatProp', origin_cm: [0, 0, 50], extent_cm: [50, 50, 50], pivot_to_base_cm: -50 },
      'now',
    );
    putProfile(profile);

    upsertConstraint({
      id: 'c_grounded',
      primitive: 'grounded',
      params: { tolerance_m: 0.05 },
      binding: { asset: '/Game/FloatProp' },
      hard: true,
    });

    // Supply a scene context with the instance floating at z=5m (base = 5 + (-0.5) = 4.5m off ground)
    const inst = {
      object: 'FloatProp_0',
      asset: '/Game/FloatProp',
      tags: {} as Record<string, string>,
      transform: { pos: [0, 0, 5] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
    };

    const guard = makeGuardFn({ scene: { instances: [inst] } });
    const floatSym: Symbol = { kind: 'tunnel', attrs: { asset: '/Game/FloatProp' } };
    const result = guard(['c_grounded'], [], floatSym);

    expect(result.hardFail).toBe(true);
  });

  it('SOFT constraint that FAILs → softFails includes id, hardFail stays false', () => {
    const profile = bakeProfile(
      { asset_id: '/Game/SoftProp', origin_cm: [0, 0, 50], extent_cm: [50, 50, 50], pivot_to_base_cm: -50 },
      'now',
    );
    putProfile(profile);

    upsertConstraint({
      id: 'c_soft_ground',
      primitive: 'grounded',
      params: { tolerance_m: 0.05 },
      binding: { asset: '/Game/SoftProp' },
      hard: false, // explicitly soft
    });

    const inst = {
      object: 'SoftProp_0',
      asset: '/Game/SoftProp',
      tags: {} as Record<string, string>,
      transform: { pos: [0, 0, 5] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
    };

    const guard = makeGuardFn({ scene: { instances: [inst] } });
    const softSym: Symbol = { kind: 'tunnel', attrs: { asset: '/Game/SoftProp' } };
    const result = guard(['c_soft_ground'], [], softSym);

    expect(result.hardFail).toBe(false);
    expect(result.softFails).toContain('c_soft_ground');
  });
});
