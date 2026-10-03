import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { meta, schema, worldQueryHandler } from './world-query.js';

let ue: ScriptedUe;
afterEach(() => ue?.restore());

describe('world_query', () => {
  const tile_id = 'tile:2:-1:3:0';
  const expected_capture_id = 'abcdef0123456789abcdef0123456789';

  it('filters authored sources against one exact capture and a sampled relation', async () => {
    ue = scriptedUe().replies('world_query', {
      status: 'partial', capture_id: expected_capture_id, tile_id,
      relation_scope: 'candidate_from_sampled_bounds',
      items: [{ source_node_id: '/Game/Level.Actor|component:Mesh',
        evidence_point_ids: [`${expected_capture_id}/${tile_id}/page:0/point:4`] }],
    });
    const result = await worldQueryHandler({
      tile_id, expected_capture_id,
      target: { kind: 'tag', value: 'stall' },
      reference: { kind: 'tag', value: 'entrance' },
      relation_kind: 'near_sampled_bounds', near_threshold_cm: 250,
    }, {} as never);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({
      status: 'partial', relation_scope: 'candidate_from_sampled_bounds',
    });
    expect(ue.calls).toEqual([{ cmd: 'world_query', params: {
      tile_id, expected_capture_id,
      target: { kind: 'tag', value: 'stall' },
      reference: { kind: 'tag', value: 'entrance' },
      relation_kind: 'near_sampled_bounds', near_threshold_cm: 250,
      offset: 0, limit: 32,
    } }]);
    expect(meta.effects).toEqual([]);
  });

  it('allows a fact-only query and an exact reference source ID', () => {
    expect(schema.safeParse({ tile_id, expected_capture_id,
      target: { kind: 'folder', value: 'Market' } }).success).toBe(true);
    expect(schema.safeParse({ tile_id, expected_capture_id,
      target: { kind: 'mesh_asset', value: '/Game/Meshes/Stall' },
      reference_source_node_id: '/Game/Level.Entrance|component:Mesh',
      relation_kind: 'above_sampled_bounds' }).success).toBe(true);
  });

  it('rejects unpinned, ambiguous, or inferred-meaning requests before Unreal dispatch', async () => {
    ue = scriptedUe();
    const base = { tile_id, expected_capture_id, target: { kind: 'tag', value: 'stall' } };
    for (const args of [
      { tile_id, target: base.target },
      { ...base, target: { kind: 'visual_label', value: 'stall' } },
      { ...base, relation_kind: 'near_sampled_bounds' },
      { ...base, reference: { kind: 'tag', value: 'entrance' } },
      { ...base, reference: { kind: 'tag', value: 'entrance' },
        reference_source_node_id: '/Game/Level.Entrance|component:Mesh',
        relation_kind: 'near_sampled_bounds' },
      { ...base, near_threshold_cm: 3000 },
      { ...base, limit: 1000 },
    ]) {
      expect(schema.safeParse(args).success).toBe(false);
      expect((await worldQueryHandler(args, {} as never)).isError).toBe(true);
    }
    expect(ue.calls).toEqual([]);
  });
});
