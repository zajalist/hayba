import { describe, it, expect } from 'vitest';
import { frameTargetExecutor, COMPOSITION_FRAME_TARGET_KIND } from './frame_target.js';
import type { SliverContext } from '../types.js';

const ctxStub: SliverContext = { stack: [], maxDepth: 8, runSliver: async () => ({ ok: true, outputs: {}, side_effects: [], durationMs: 0 }) };

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

  it('exports the registry kind as a constant', () => {
    expect(COMPOSITION_FRAME_TARGET_KIND).toBe('composition.frame_target');
  });
});
