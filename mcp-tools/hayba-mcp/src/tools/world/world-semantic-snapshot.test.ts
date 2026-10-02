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
      section: 'overview', offset: 0, limit: 32, member_kind: 'nodes',
    } }]);
  });

  it('bounds pages, carries the scan ID, and classifies native command as a read', async () => {
    ue = scriptedUe().replies('world_semantic_snapshot', { section: 'members', items: [4], next_offset: null });
    await worldSemanticSnapshotHandler({ section: 'members', cluster_index: 7, offset: 32,
      expected_scan_id: 'A1B2C3D4' }, {} as never);
    expect(ue.calls).toEqual([{ cmd: 'world_semantic_snapshot', params: {
      section: 'members', cluster_index: 7, offset: 32, limit: 32,
      member_kind: 'nodes', expected_scan_id: 'A1B2C3D4',
    } }]);
    expect(schema.safeParse({ limit: 50 }).success).toBe(false);
    expect(schema.safeParse({ expected_scan_id: 'stale' }).success).toBe(false);
    expect(native('HaybaMCPCommandSets.h')).toContain('TEXT("world_semantic_snapshot")');
  });
});
