import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { schema, worldSemanticSnapshotHandler } from './world-semantic-snapshot.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const native = (path: string) => readFileSync(join(root, 'unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private', path), 'utf8');
let ue: ScriptedUe;
afterEach(() => ue?.restore());

describe('world_semantic_snapshot', () => {
  it('requests a compact overview without whole hierarchy arrays by default', async () => {
    ue = scriptedUe().replies('world_semantic_snapshot', {
      coverage: { loadedOnly: true, truncated: false },
      totals: { actors: 144, nodes: 215, clusters: 56, splats: 4096 }, items: [],
    });
    const result = await worldSemanticSnapshotHandler({}, {} as never);
    expect(result.isError).toBeUndefined();
    expect(ue.calls).toEqual([{ cmd: 'world_semantic_snapshot', params: {
      source: 'mesh', section: 'overview', offset: 0, limit: 32, member_kind: 'nodes',
    } }]);
  });

  it('bounds pages, carries the scan ID, and classifies native command as a read', async () => {
    ue = scriptedUe().replies('world_semantic_snapshot', { section: 'members', items: [4], next_offset: null });
    await worldSemanticSnapshotHandler({ section: 'members', cluster_index: 7, offset: 32,
      expected_scan_id: 'A1B2C3D4' }, {} as never);
    expect(ue.calls).toEqual([{ cmd: 'world_semantic_snapshot', params: {
      source: 'mesh', section: 'members', cluster_index: 7, offset: 32, limit: 32,
      member_kind: 'nodes', expected_scan_id: 'A1B2C3D4',
    } }]);
    expect(schema.safeParse({ limit: 50 }).success).toBe(false);
    expect(schema.safeParse({ expected_scan_id: 'stale' }).success).toBe(false);
    expect(native('HaybaMCPCommandSets.h')).toContain('TEXT("world_semantic_snapshot")');
  });

  it('pages an observed view-depth capture independently of mesh indices', async () => {
    const captureId = '0123456789abcdef0123456789abcdef';
    ue = scriptedUe().replies('world_semantic_snapshot', {
      source: 'view_depth', capture_id: captureId,
      coverage: { visibility: 'first_depth_surface_from_one_editor_view', whole_world_coverage: false },
      items: [{ spatial_group_id: 'cell:1:-2:0', source_attribution: 'unknown' }],
    });
    const result = await worldSemanticSnapshotHandler({ source: 'view_depth', section: 'points',
      group_id: 'cell:1:-2:0', expected_capture_id: captureId, offset: 32 }, {} as never);
    expect(result.isError).toBeUndefined();
    expect(ue.calls).toEqual([{ cmd: 'world_semantic_snapshot', params: {
      source: 'view_depth', section: 'points', group_id: 'cell:1:-2:0',
      expected_capture_id: captureId, offset: 32, limit: 32, member_kind: 'nodes',
    } }]);
    expect(schema.safeParse({ source: 'view_depth', section: 'splats' }).success).toBe(false);
    expect(schema.safeParse({ source: 'view_depth', section: 'points', node_index: 0 }).success).toBe(false);
    expect(schema.safeParse({ source: 'view_depth', expected_capture_id: 'stale' }).success).toBe(false);
    expect(schema.safeParse({ source: 'mesh', section: 'points' }).success).toBe(false);
    expect(schema.safeParse({ source: 'mesh', group_id: 'cell:0:0:0' }).success).toBe(false);
    expect(native('HaybaMCPSceneMapWebPanel.cpp')).toContain('ObservedDepth.AddPoint(MoveTemp(ObservedPoint))');
    expect(native('HaybaMCPViewDepthSnapshot.cpp')).toContain('source_attribution');
  });

  it('queries captured geometry tiles by stable tile and page IDs without a new editor scan', async () => {
    const captureId = 'fedcba9876543210fedcba9876543210';
    ue = scriptedUe().replies('world_semantic_snapshot', {
      source: 'cpu_render_lod_world_tile', status: 'captured', tile_id: 'tile:2:-1:3:0',
      capture_id: captureId, items: [{ id: 'tile:2:-1:3:0/page:0/point:12',
        actor_path: '/Game/Maps/World.Actor', source_node_id: '/Game/Maps/World.Actor|component:Mesh' }],
    });
    const result = await worldSemanticSnapshotHandler({ source: 'mesh_tile', section: 'points',
      tile_id: 'tile:2:-1:3:0', page_id: 0, offset: 12, expected_capture_id: captureId }, {} as never);
    expect(result.isError).toBeUndefined();
    expect(ue.calls).toEqual([{ cmd: 'world_semantic_snapshot', params: {
      source: 'mesh_tile', section: 'points', tile_id: 'tile:2:-1:3:0', page_id: 0,
      offset: 12, limit: 32, expected_capture_id: captureId, member_kind: 'nodes',
    } }]);
    expect(schema.safeParse({ source: 'mesh_tile', tile_id: 'tile:2:-1:3:0' }).success).toBe(true);
    expect(schema.safeParse({ source: 'mesh_tile', tile_id: 'tile:2:-1:3:0',
      expected_capture_id: captureId }).success).toBe(true);
    expect(schema.safeParse({ source: 'mesh_tile', section: 'pages', tile_id: 'tile:2:-1:3:0',
      expected_capture_id: captureId }).success).toBe(true);
    expect(schema.safeParse({ source: 'mesh_tile', section: 'semantic', tile_id: 'tile:2:-1:3:0',
      expected_capture_id: captureId }).success).toBe(true);
    expect(schema.safeParse({ source: 'mesh_tile', section: 'relations', tile_id: 'tile:2:-1:3:0',
      expected_capture_id: captureId }).success).toBe(true);
    expect(schema.safeParse({ source: 'mesh_tile', section: 'relations', tile_id: 'tile:2:-1:3:0' }).success).toBe(false);
    expect(schema.safeParse({ source: 'mesh_tile', section: 'relations', tile_id: 'tile:2:-1:3:0',
      expected_capture_id: captureId, page_id: 0 }).success).toBe(false);
    expect(schema.safeParse({ source: 'mesh_tile', section: 'pages', tile_id: 'tile:2:-1:3:0' }).success).toBe(false);
    expect(schema.safeParse({ source: 'mesh_tile', section: 'points', tile_id: 'tile:2:-1:3:0' }).success).toBe(false);
    expect(schema.safeParse({ source: 'mesh_tile', section: 'pages', tile_id: 'tile:2:-1:3:0', page_id: 0 }).success).toBe(false);
    expect(schema.safeParse({ source: 'mesh_tile', section: 'points', tile_id: 'tile:2:-1:3:0', page_id: 0,
      cluster_index: 1 }).success).toBe(false);
    expect(schema.safeParse({ source: 'mesh_tile', tile_id: 'tile:2:9999999999999999:0:0' }).success).toBe(false);
    expect(schema.safeParse({ source: 'mesh', tile_id: 'tile:0:0:0:0' }).success).toBe(false);
    expect(schema.safeParse({ source: 'mesh', section: 'relations' }).success).toBe(false);
    expect(schema.safeParse({ source: 'view_depth', page_id: 0 }).success).toBe(false);
    expect(native('handlers/HaybaMCPSceneGraphHandler.cpp')).toContain('HaybaWorldTileSnapshot::GetForWorld(World, TileId, ExpectedCaptureId)');
  });

  it('pages provisional spatial relations against one exact tile capture', async () => {
    const captureId = '0123456789abcdef0123456789abcdef';
    ue = scriptedUe().replies('world_semantic_snapshot', {
      source: 'captured_mesh_tile_relations', capture_id: captureId,
      relation_scope: 'candidates_from_sampled_axis_aligned_bounds',
      items: [{ kind: 'near_sampled_bounds', evidence_point_ids: [`${captureId}/tile:2:0:0:0/page:0/point:0`] }],
    });
    const result = await worldSemanticSnapshotHandler({ source: 'mesh_tile', section: 'relations',
      tile_id: 'tile:2:0:0:0', expected_capture_id: captureId, offset: 32 }, {} as never);
    expect(result.isError).toBeUndefined();
    expect(ue.calls).toEqual([{ cmd: 'world_semantic_snapshot', params: {
      source: 'mesh_tile', section: 'relations', tile_id: 'tile:2:0:0:0',
      expected_capture_id: captureId, offset: 32, limit: 32, member_kind: 'nodes',
    } }]);
    expect(native('handlers/HaybaMCPSceneGraphHandler.cpp')).toContain('HaybaWorldRelations::Build(*Snapshot)');
  });
});
