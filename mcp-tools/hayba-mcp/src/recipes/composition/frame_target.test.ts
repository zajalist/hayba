import { describe, it, expect } from 'vitest';
import { frameTargetExecutor, COMPOSITION_FRAME_TARGET_KIND } from './frame_target.js';
import type { RecipeContext } from '../types.js';

const ctxStub: RecipeContext = {
  stack: [], maxDepth: 8,
  runRecipe: async () => ({ ok: true, outputs: {}, side_effects: [], durationMs: 0 }),
  placed: () => {},
};

describe('frameTargetExecutor', () => {
  it('returns a camera_transform object with location, rotation, and fov', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/Heroes/SK_Hero.SK_Hero',
      distance: 10,
      height: 2,
      fov: 70,
      yaw_deg: 0,
    }, ctxStub);
    expect(out).toHaveProperty('camera_transform');
    const t = out.camera_transform as { location: number[]; rotation: number[]; fov: number };
    expect(t.location).toHaveLength(3);
    expect(t.rotation).toHaveLength(3);
    expect(t.fov).toBe(70);
  });

  it('at yaw=0 places the camera on +X axis at the given distance', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/X.X', distance: 10, height: 0, fov: 70, yaw_deg: 0,
    }, ctxStub) as { camera_transform: { location: [number, number, number] } };
    expect(out.camera_transform.location[0]).toBeCloseTo(1000, 1); // 10m → 1000 UE units
    expect(out.camera_transform.location[1]).toBeCloseTo(0, 1);
  });

  it('at yaw=90 places the camera on +Y axis', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/X.X', distance: 10, height: 0, fov: 70, yaw_deg: 90,
    }, ctxStub) as { camera_transform: { location: [number, number, number] } };
    expect(out.camera_transform.location[0]).toBeCloseTo(0, 1);
    expect(out.camera_transform.location[1]).toBeCloseTo(1000, 1);
  });

  it('applies the height offset to Z (meters → centimetres)', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/X.X', distance: 10, height: 3, fov: 70, yaw_deg: 0,
    }, ctxStub) as { camera_transform: { location: [number, number, number] } };
    expect(out.camera_transform.location[2]).toBeCloseTo(300, 1);
  });

  it('points yaw toward the origin (camera at +X looks toward −X)', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/X.X', distance: 10, height: 0, fov: 70, yaw_deg: 0,
    }, ctxStub) as { camera_transform: { rotation: [number, number, number] } };
    // rotation in [pitch, yaw, roll] degrees per UE convention
    expect(out.camera_transform.rotation[1]).toBeCloseTo(180, 1);
  });

  it('orbits around target_location when supplied (not the world origin)', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/X.X', target_location: [5000, 2000, 300],
      distance: 10, height: 0, fov: 70, yaw_deg: 0,
    }, ctxStub) as { camera_transform: { location: [number, number, number] } };
    // pivot + orbit offset: yaw=0 → +1000 on X, height 0 keeps pivot Z.
    expect(out.camera_transform.location[0]).toBeCloseTo(6000, 1);
    expect(out.camera_transform.location[1]).toBeCloseTo(2000, 1);
    expect(out.camera_transform.location[2]).toBeCloseTo(300, 1);
  });

  it('adds the height offset on top of the pivot Z', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/X.X', target_location: [0, 0, 1000],
      distance: 10, height: 3, fov: 70, yaw_deg: 0,
    }, ctxStub) as { camera_transform: { location: [number, number, number] } };
    expect(out.camera_transform.location[2]).toBeCloseTo(1300, 1); // 1000 pivot + 300 offset
  });

  it('omitting target_location frames the world origin (backward compatible)', async () => {
    const without = await frameTargetExecutor({
      target: '/Game/X.X', distance: 10, height: 2, fov: 70, yaw_deg: 45,
    }, ctxStub) as { camera_transform: { location: number[] } };
    const withZero = await frameTargetExecutor({
      target: '/Game/X.X', target_location: [0, 0, 0],
      distance: 10, height: 2, fov: 70, yaw_deg: 45,
    }, ctxStub) as { camera_transform: { location: number[] } };
    expect(without.camera_transform.location).toEqual(withZero.camera_transform.location);
  });

  it('exports the registry kind as a constant', () => {
    expect(COMPOSITION_FRAME_TARGET_KIND).toBe('composition.frame_target');
  });
});
