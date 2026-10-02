import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { schema, worldBudgetSnapshotHandler } from './world-budget-snapshot.js';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const native = (path: string) => readFileSync(join(root, 'unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private', path), 'utf8');
let ue: ScriptedUe;
afterEach(() => ue?.restore());

describe('world_budget_snapshot', () => {
  it('forwards only bounded structural scope and targets to native read', async () => {
    ue = scriptedUe().replies('world_budget_snapshot', {
      coverage: { scope: 'currently_loaded_editor_actors', scan_complete: true },
      measured_structure: { loaded_actor_count: 17 },
      production_performance_verdict: 'unknown_not_measured',
    });
    const result = await worldBudgetSnapshotHandler({ folder: 'City/Market', max_loaded_actors: 20 }, {} as never);
    expect(result.isError).toBeUndefined();
    expect(ue.calls).toEqual([{ cmd: 'world_budget_snapshot', params: { folder: 'City/Market', max_loaded_actors: 20 } }]);
  });

  it('rejects invalid limits and unbounded folder arguments before transport', async () => {
    ue = scriptedUe();
    expect(schema.safeParse({ max_loaded_actors: -1 }).success).toBe(false);
    expect(schema.safeParse({ max_loaded_ism_instances: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ folder: 'x'.repeat(1025) }).success).toBe(false);
    const result = await worldBudgetSnapshotHandler({ max_loaded_actors: -1 }, {} as never);
    expect(result.isError).toBe(true);
    expect(ue.calls).toEqual([]);
  });

  it('has an explicit read classification and no unsupported performance verdict', () => {
    const commandSets = native('HaybaMCPCommandSets.h');
    const handler = native('handlers/HaybaMCPActorHandler.cpp');
    expect(commandSets).toContain('TEXT("world_budget_snapshot")');
    expect(handler).toContain('TEXT("unknown_not_measured")');
    expect(handler).toContain('TEXT("unloaded_world_partition_actors"), TEXT("unknown")');
    expect(handler).toContain('TEXT("unloaded_pcg_generated_instances"), TEXT("unknown")');
    expect(handler).toContain('TEXT("folder_scope_kind"), TEXT("path_aggregate_across_loaded_folder_roots")');
    expect(handler).toContain('TEXT("folder_identity"), TEXT("folder_path_only_root_identity_not_measured")');
    expect(handler).toContain('TEXT("folder_rows_scope"), TEXT("path_aggregate_across_loaded_folder_roots")');
    expect(handler).toContain('TEXT("folder_path_aggregate_across_loaded_roots")');
    expect(handler).toContain('Actor->GetFolderPath().ToString()');
    expect(handler).not.toContain('TEXT("performance_pass")');
  });
});
