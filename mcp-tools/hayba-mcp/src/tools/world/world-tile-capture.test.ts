import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { meta, schema, worldTileCaptureHandler } from './world-tile-capture.js';

let ue: ScriptedUe;
afterEach(() => ue?.restore());

describe('world_tile_capture', () => {
  const tileId = 'tile:2:-1:3:0';
  const captureId = '0123456789abcdef0123456789abcdef';

  it('starts a bounded tile request and returns its capture ID for polling', async () => {
    ue = scriptedUe().replies('world_tile_capture', {
      action: 'start',
      status: 'queued',
      tile_id: tileId,
      capture_id: captureId,
      scanned_actor_slots: 0,
      eligible_actor_count: 0,
      processed_actor_count: 0,
      point_count: 0,
      page_count: 0,
      gaps: [],
      deduplicated: false,
    });
    const result = await worldTileCaptureHandler({ action: 'start', tile_id: tileId }, {} as never);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ status: 'queued', capture_id: captureId });
    expect(ue.calls).toEqual([{ cmd: 'world_tile_capture', params: { action: 'start', tile_id: tileId } }]);
    expect(meta.effects).toEqual([]);
  });

  it('passes a world position and LOD through to the native tile resolver', async () => {
    const position = { x: -1, y: 4_000, z: 0 };
    ue = scriptedUe().replies('world_tile_capture', {
      action: 'start',
      status: 'queued',
      tile_id: 'tile:1:-1:2:0',
      capture_id: captureId,
    });

    const result = await worldTileCaptureHandler({ action: 'start', position_cm: position, lod: 1 }, {} as never);

    expect(result.isError).toBeUndefined();
    expect(ue.calls).toEqual([
      {
        cmd: 'world_tile_capture',
        params: { action: 'start', position_cm: position, lod: 1 },
      },
    ]);
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({
      tile_id: 'tile:1:-1:2:0',
      capture_id: captureId,
    });
  });

  it('accepts finite fractional coordinates through the inclusive centimeter bounds', () => {
    expect(
      schema.safeParse({
        action: 'start',
        position_cm: { x: -100_000_000, y: 0.5, z: 100_000_000 },
        lod: 2,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        action: 'start',
        position_cm: { x: 0, y: 0, z: 0 },
        lod: 0,
      }).success,
    ).toBe(true);
  });

  it('polls and cancels the exact capture without requesting another tile', async () => {
    ue = scriptedUe().replies('world_tile_capture', {
      action: 'status',
      status: 'sampling',
      tile_id: tileId,
      capture_id: captureId,
      scanned_actor_slots: 256,
      eligible_actor_count: 20,
      processed_actor_count: 5,
      point_count: 120,
      page_count: 1,
      gaps: [],
    });
    const result = await worldTileCaptureHandler({ action: 'status', capture_id: captureId }, {} as never);
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ status: 'sampling', processed_actor_count: 5 });
    expect(ue.calls).toEqual([{ cmd: 'world_tile_capture', params: { action: 'status', capture_id: captureId } }]);

    await worldTileCaptureHandler({ action: 'cancel', capture_id: captureId }, {} as never);
    expect(ue.calls[1]).toEqual({ cmd: 'world_tile_capture', params: { action: 'cancel', capture_id: captureId } });
  });

  it('rejects ambiguous keys and invalid addresses before dispatch', async () => {
    ue = scriptedUe();
    for (const args of [
      { action: 'start' },
      { action: 'start', tile_id: tileId, capture_id: captureId },
      { action: 'start', position_cm: { x: 1, y: 2, z: 3 } },
      { action: 'start', lod: 1 },
      { action: 'start', tile_id: tileId, lod: 1 },
      { action: 'start', tile_id: tileId, position_cm: { x: 1, y: 2, z: 3 }, lod: 1 },
      { action: 'start', position_cm: { x: 1, y: 2, z: 3 }, lod: 1, capture_id: captureId },
      { action: 'status' },
      { action: 'cancel', tile_id: tileId, capture_id: captureId },
      { action: 'status', capture_id: captureId, position_cm: { x: 1, y: 2, z: 3 }, lod: 1 },
      { action: 'cancel', tile_id: tileId, lod: 1 },
      { action: 'start', tile_id: 'tile:9:0:0:0' },
      { action: 'status', capture_id: 'not-a-capture-id' },
      { action: 'start', position_cm: { x: 100_000_001, y: 0, z: 0 }, lod: 0 },
      { action: 'start', position_cm: { x: -100_000_001, y: 0, z: 0 }, lod: 0 },
      { action: 'start', position_cm: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 }, lod: 0 },
      { action: 'start', position_cm: { x: Number.NaN, y: 0, z: 0 }, lod: 0 },
      { action: 'start', position_cm: { x: 0, y: 0 }, lod: 0 },
      { action: 'start', position_cm: { x: 0, y: 0, z: 0, radius: 10 }, lod: 0 },
      { action: 'start', position_cm: { x: 0, y: 0, z: 0 }, lod: 0.5 },
      { action: 'start', position_cm: { x: 0, y: 0, z: 0 }, lod: 3 },
      { action: 'start', position_cm: { x: 0, y: 0, z: 0 }, lod: 1, unexpected: true },
    ]) {
      expect(schema.safeParse(args).success).toBe(false);
      expect((await worldTileCaptureHandler(args, {} as never)).isError).toBe(true);
    }
    expect(ue.calls).toEqual([]);
  });
});
