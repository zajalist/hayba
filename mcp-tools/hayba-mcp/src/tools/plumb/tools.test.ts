import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { plumbProfileBakeHandler, plumbConstraintProposeHandler, plumbMaskAddHandler, plumbMaskRemoveHandler, plumbSegmentHandler } from './tools.js';
import { putProfile, bakeProfile, setProfilesPath, getMask } from '../../plumb/index.js';

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

  it('adds and removes a volume mask via the tool', async () => {
    putProfile(bakeProfile({ asset_id: '/Game/Door', origin_cm: [0,0,0], extent_cm: [50,10,100] }, 'now'));
    const add = await plumbMaskAddHandler({ asset: '/Game/Door', id: 'swing_front', type: 'volume', shape: { kind: 'box', transform: { pos: [0,1,0], quat: [0,0,0,1], scale: [1,1,1] }, extents: [1,1,2] } });
    expect(add.ok).toBe(true);
    const rm = await plumbMaskRemoveHandler({ asset: '/Game/Door', mask_id: 'swing_front' });
    expect(rm.removed).toBe(true);
  });

  it('mask_add errors with no base profile', async () => {
    const r = await plumbMaskAddHandler({ asset: '/Game/Nope', id: 'm', type: 'surface', triangles: [1] });
    expect(r.ok).toBe(false);
  });
});

describe('plumb_segment (sidecar bridge)', () => {
  let dir: string;
  const realFetch = globalThis.fetch;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pseg-')); setProfilesPath(join(dir, 'p.json')); });
  afterEach(() => { setProfilesPath(null); rmSync(dir, { recursive: true, force: true }); globalThis.fetch = realFetch; });

  it('writes projected masks (with texture + triangles) returned by the sidecar', async () => {
    putProfile(bakeProfile({ asset_id: '/Game/Boat', origin_cm: [0,0,0], extent_cm: [100,40,30] }, 'now'));
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      masks: [{ label: 'hull', texture: '/s/masks/hull.png', triangles: [3,4,5], color: '#48A0FF', coverage: 0.42 }],
      skipped: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const r = await plumbSegmentHandler({
      asset: '/Game/Boat', study_dir: '/s',
      parts: [{ label: 'hull', color: '#48A0FF', views: [{ view: 0, box: [1,2,3,4] }] }],
    });
    expect(r.ok).toBe(true);
    expect(r.added).toEqual(['hull']);
    const m = getMask('/Game/Boat', 'hull')!;
    expect(m.texture).toBe('/s/masks/hull.png');
    expect(m.triangles).toEqual([3,4,5]);
    expect(m.source).toBe('ai');
  });

  it('returns a clean error when the sidecar is unreachable', async () => {
    putProfile(bakeProfile({ asset_id: '/Game/Boat', origin_cm: [0,0,0], extent_cm: [100,40,30] }, 'now'));
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    const r = await plumbSegmentHandler({ asset: '/Game/Boat', study_dir: '/s', parts: [{ label: 'hull', views: [{ view: 0, box: [0,0,1,1] }] }] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sidecar/i);
  });
});
