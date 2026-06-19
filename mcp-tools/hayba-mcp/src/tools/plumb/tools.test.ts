import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { plumbProfileBakeHandler, plumbConstraintProposeHandler } from './tools.js';
import { setProfilesPath } from '../../plumb/index.js';

describe('plumb_profile_bake auto-fetch', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pbake-')); setProfilesPath(join(dir, 'p.json')); });
  afterEach(() => { setProfilesPath(null); rmSync(dir, { recursive: true, force: true }); });

  it('derives origin/extent/pivot from fetched bounds (EditorCube)', async () => {
    const fetch = async () => ({ min: [-128, -128, -128] as [number, number, number], max: [128, 128, 128] as [number, number, number], extents: [128, 128, 128] as [number, number, number] });
    const r = await plumbProfileBakeHandler({ asset: '/Engine/EditorMeshes/EditorCube' }, 'now', fetch);
    expect(r.ok).toBe(true);
    const p = r.profile as { structural: { ground_offset_m: number }; geometry: { aabb: { max: number[] } } };
    expect(p.structural.ground_offset_m).toBeCloseTo(-1.28, 5);  // min.z -128cm
    expect(p.geometry.aabb.max[2]).toBeCloseTo(1.28, 5);
  });

  it('errors when bounds omitted and no fetcher available', async () => {
    const r = await plumbProfileBakeHandler({ asset: '/X' }, 'now');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/auto-fetch/);
  });

  it('explicit bounds bypass the fetcher', async () => {
    let called = false;
    const fetch = async () => { called = true; return { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number], extents: [1, 1, 1] as [number, number, number] }; };
    const r = await plumbProfileBakeHandler({ asset: '/X', origin_cm: [0, 0, 50], extent_cm: [50, 50, 50] }, 'now', fetch);
    expect(r.ok).toBe(true);
    expect(called).toBe(false);
  });

  it('propose then needs a baked profile', async () => {
    const miss = await plumbConstraintProposeHandler({ asset: '/Game/Nope' });
    expect(miss.ok).toBe(false);
  });
});
