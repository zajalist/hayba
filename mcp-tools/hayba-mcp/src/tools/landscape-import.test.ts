import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { STATIC_TOOL_CATALOGUE } from './index.js';
import { scriptedUe, type ScriptedUe } from './testing/scripted-ue.js';
import type { WorkflowResult } from './workflows/contracts.js';

let ue: ScriptedUe | undefined;
afterEach(() => { ue?.restore(); ue = undefined; });

const nativeWorld = {
  world: { type: 'Editor', package: '/Game/Maps/Test', current_level: '/Game/Maps/Test', coordinate_system: 'left_handed_z_up_centimeters', scale: 100 },
  landscape: [], partition: { enabled: false, runtime_grids: [] }, data_layers: [],
  hlod: { layers: [] }, capabilities: { world_partition: true, hlod: true, web_browser: false }, save_ready: true,
};
const landscapePath = '/Game/Maps/Test.Test:PersistentLevel.Landscape_1';

function successfulImport() {
  let imported = false;
  ue = scriptedUe()
    .replies('world_inspect', () => ({ ...nativeWorld, landscape: imported ? [{ path: landscapePath }] : [] }))
    .replies('landscape_import', () => { imported = true; return { actorLabel: 'Terrain' }; })
    .replies('level_save', { saved: true, verified: true, dirty: false });
}

async function invoke(name: string, input: Record<string, unknown>) {
  const descriptor = STATIC_TOOL_CATALOGUE.find((tool) => tool.name === name);
  expect(descriptor, `${name} must remain callable`).toBeDefined();
  const response = await descriptor!.handler(z.object(descriptor!.schema).parse(input), {});
  const text = response.content.find((block) => block.type === 'text');
  expect(text).toBeDefined();
  return { response, result: JSON.parse(text!.text) as WorkflowResult & {
    deprecation: { deprecated: boolean; replacement: string; removal: string };
  } };
}

describe.each(['hayba_import_landscape', 'import_landscape'])('%s compatibility adapter', (name) => {
  it('maps legacy inputs losslessly into the shared ingestion plan and native importer', async () => {
    successfulImport();
    const input = {
      heightmapPath: 'D:/terrain.r16', worldSizeKm: 2.5, maxHeightM: 350,
      actorLabel: 'Mountain', landscapeMaterial: '/Game/Materials/Terrain',
    };
    const { response, result } = await invoke(name, input);
    expect(response.isError).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.operationId).toEqual(expect.any(String));
    expect(result.operationId.length).toBeGreaterThan(0);
    expect(result.deprecation).toEqual({ deprecated: true, replacement: 'world_ingest', removal: 'after_one_release' });
    const plan = JSON.parse(result.stages.find((stage) => stage.stage === 'plan')!.summary!);
    expect(plan.request).toMatchObject({
      source: { kind: 'heightmap', path: 'D:/terrain.r16' },
      destination: { mode: 'open_world' }, partition: { mode: 'preserve' },
      terrain: { worldSizeKm: 2.5, maxHeightM: 350, actorLabel: 'Mountain', material: '/Game/Materials/Terrain' },
    });
    expect(ue!.paramsFor('landscape_import')).toEqual(input);
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      'inspect', 'normalize', 'plan', 'terrain', 'partition', 'assets', 'saveVerify', 'validate',
    ]);
    expect(result.stages.find((stage) => stage.stage === 'partition')?.status).toBe('skipped');
  });

  it('preserves the old defaults when optional fields are absent', async () => {
    successfulImport();
    const { result } = await invoke(name, { heightmapPath: 'D:/terrain.r16' });
    expect(result.ok).toBe(true);
    expect(ue!.paramsFor('landscape_import')).toEqual({
      heightmapPath: 'D:/terrain.r16', worldSizeKm: 8, maxHeightM: 600, actorLabel: 'Hayba_Terrain',
    });
  });

  it('retains explicit zero values and empty label, and treats empty material as no material', async () => {
    successfulImport();
    const { result } = await invoke(name, {
      heightmapPath: 'D:/terrain.r16', worldSizeKm: 0, maxHeightM: 0, actorLabel: '', landscapeMaterial: '',
    });
    expect(result.ok).toBe(true);
    expect(ue!.paramsFor('landscape_import')).toEqual({
      heightmapPath: 'D:/terrain.r16', worldSizeKm: 0, maxHeightM: 0, actorLabel: '',
    });
  });

  it('preserves import-only behavior without calling save even when save is unavailable', async () => {
    successfulImport();
    ue!.replies('level_save', { saved: true });
    const { response, result } = await invoke(name, { heightmapPath: 'D:/terrain.r16' });
    expect(response.isError).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.operationId).toEqual(expect.any(String));
    expect(result.deprecation.replacement).toBe('world_ingest');
    expect(result.stages.find((stage) => stage.stage === 'saveVerify')).toMatchObject({ status: 'skipped', code: 'legacy_import_only' });
    expect(ue!.called('level_save')).toBe(false);
    expect(result.affectedResources).toEqual([{ kind: 'landscape', id: landscapePath, path: landscapePath }]);
  });
});
