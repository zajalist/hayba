import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { STATIC_TOOL_CATALOGUE } from '../index.js';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { WorkflowResultSchema, type WorldIngestRequest } from '../workflows/contracts.js';
import { createNativeWorldIngestDependencies, runWorldIngest } from './world-ingest.js';

// Exercise published schemas/handlers and the real native adapter. Only the
// external UE executor is scripted; these are not live editor acceptance tests.
let ue: ScriptedUe | undefined;
afterEach(() => { ue?.restore(); ue = undefined; });

const world = {
  world: { type: 'Editor', package: '/Game/Maps/Contract', current_level: '/Game/Maps/Contract', coordinate_system: 'left_handed_z_up_centimeters', scale: 100 },
  landscape: [], partition: { enabled: false, runtime_grids: [] }, data_layers: [],
  hlod: { layers: [] }, capabilities: { world_partition: true, hlod: true, web_browser: false }, save_ready: true,
};
const landscapePath = '/Game/Maps/Contract.Contract:PersistentLevel.Landscape_1';
const landscape = { kind: 'landscape', id: landscapePath, path: landscapePath };
const heightmap: WorldIngestRequest = {
  source: { kind: 'heightmap', path: 'D:/Terrain/tile_x0_y0.r16', format: 'r16' },
  destination: { mode: 'open_world' }, partition: { mode: 'preserve' },
};

function descriptor(name: string) {
  const tool = STATIC_TOOL_CATALOGUE.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing public tool: ${name}`);
  return tool;
}

async function invoke(name: string, input: Record<string, unknown>) {
  const tool = descriptor(name);
  const response = await tool.handler(z.object(tool.schema).parse(input), {});
  const text = response.content.find((block) => block.type === 'text');
  if (!text) throw new Error(`${name} returned no text`);
  const result = WorkflowResultSchema.parse(JSON.parse(text.text));
  expect(response.isError).toBe(!result.ok);
  return result;
}

function importableWorld(onImport?: () => void) {
  let imported = false;
  return scriptedUe()
    .replies('world_inspect', () => ({ ...world, landscape: imported ? [{ path: landscapePath, package: '/Game/Maps/Contract' }] : [] }))
    .replies('landscape_import', () => { imported = true; onImport?.(); return { actorLabel: 'Terrain' }; })
    .replies('level_save', { path: '/Game/Maps/Contract', saved: true, verified: true, dirty: false });
}

describe('generalized world workflow public contracts', () => {
  it('keeps asset_inspect as the existing read-only metadata tool with asset_path input', async () => {
    const metadata = { ok: true, asset_path: '/Game/Terrain/SM_Tile', class: 'StaticMesh', dirty: false, dep_count: 2, ref_count: 1 };
    ue = scriptedUe().replies('python_run', { stdout: `HAYBA_JSON:${JSON.stringify(metadata)}` });
    const tool = descriptor('asset_inspect');
    const response = await tool.handler(z.object(tool.schema).parse({ asset_path: '/Game/Terrain/SM_Tile' }), {});
    const text = response.content.find((block) => block.type === 'text');
    expect(response.isError).not.toBe(true);
    expect(JSON.parse(text!.text)).toEqual(metadata);
    expect(tool.meta.effects).toEqual([]);
    expect(ue.calls.map((call) => call.cmd)).toEqual(['python_run']);
  });

  it('accepts a single tiled-heightmap filename, preserves its plan, and verifies import/save without claiming tile assembly', async () => {
    ue = importableWorld();
    const input = { ...heightmap, terrain: { worldSizeKm: 2, maxHeightM: 350, actorLabel: 'Tile_0_0' } };
    const dryRun = await invoke('world_ingest', { ...input, execution: { dryRun: true } });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.affectedResources).toEqual([]);
    expect(JSON.parse(dryRun.stages.find((stage) => stage.stage === 'plan')!.summary!).request).toMatchObject(input);
    expect(dryRun.stages.slice(3).map((stage) => [stage.stage, stage.status, stage.code])).toEqual([
      ['terrain', 'skipped', 'dry_run'], ['partition', 'skipped', 'dry_run'], ['assets', 'skipped', 'dry_run'],
      ['saveVerify', 'skipped', 'dry_run'], ['validate', 'skipped', 'dry_run'],
    ]);
    expect(ue.calls.map((call) => call.cmd)).toEqual(['world_inspect']);

    // Multiple-tile manifests are not part of the published source shape.
    expect(z.object(descriptor('world_ingest').schema).safeParse({
      ...input, source: { ...input.source, tiles: ['tile_x0_y0.r16', 'tile_x1_y0.r16'] },
    }).success).toBe(false);

    const result = await invoke('world_ingest', input);
    expect(result.ok).toBe(true);
    expect(result.affectedResources).toEqual([landscape]);
    expect(result.stages.map((stage) => [stage.stage, stage.status])).toEqual([
      ['inspect', 'succeeded'], ['normalize', 'succeeded'], ['plan', 'succeeded'], ['terrain', 'succeeded'],
      ['partition', 'skipped'], ['assets', 'skipped'], ['saveVerify', 'succeeded'], ['validate', 'succeeded'],
    ]);
    expect(ue.paramsFor('landscape_import')).toEqual({
      heightmapPath: 'D:/Terrain/tile_x0_y0.r16', worldSizeKm: 2, maxHeightM: 350, actorLabel: 'Tile_0_0',
    });
    expect(ue.paramsFor('level_save')).toEqual({ path: '/Game/Maps/Contract' });
  });

  it.each([false, true])('preserves a managed world by refusing unsupported managed_update before mutation (dryRun=%s)', async (dryRun) => {
    const managedWorld = {
      ...world, landscape: [{ path: landscapePath }],
      partition: { enabled: true, runtime_grids: ['AuthoredGrid'] },
      data_layers: ['Gameplay'], hlod: { layers: ['AuthoredHLOD'] },
    };
    ue = scriptedUe().replies('world_inspect', managedWorld);
    const result = await invoke('world_ingest', {
      ...heightmap, destination: { mode: 'managed_update', importId: 'terrain-release-1' }, execution: { dryRun },
    });
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'normalize', status: 'unsupported', code: 'destination_mode_unavailable' });
    expect(result.affectedResources).toEqual([]);
    expect(ue.calls.map((call) => call.cmd)).toEqual(['world_inspect']);
    const inspected = await descriptor('world_inspect').handler({}, {});
    const text = inspected.content.find((block) => block.type === 'text');
    expect(JSON.parse(text!.text).facts.worldPartition).toEqual({
      enabled: true, runtimeGrids: ['AuthoredGrid'], dataLayers: ['Gameplay'], hlodLayers: ['AuthoredHLOD'],
    });
  });

  it('refuses mesh terrain ingestion and explicit Nanite preparation while allowing existing LOD edits under auto', async () => {
    ue = scriptedUe().replies('world_inspect', world).replies('mesh_get_info', {
      path: '/Game/Terrain/SM_Tile', lod_count: 2, lod_screen_sizes: [1, 0.5],
    }).replies('mesh_set_lod', (params) => ({ ok: true, ...params }));
    const result = await invoke('world_ingest', {
      source: { kind: 'mesh_terrain', path: '/Game/Terrain/SM_Tile' },
      destination: { mode: 'open_world' }, assets: { intent: 'terrain', nanite: 'enable' },
    });
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'normalize', status: 'unsupported', code: 'source_kind_unavailable' });
    expect(ue.calls.map((call) => call.cmd)).toEqual(['world_inspect']);

    const explicit = await invoke('asset_prepare', {
      assetPath: '/Game/Terrain/SM_Tile', policy: { intent: 'terrain', nanite: 'enable', lods: { reduction: 0.5 } },
    });
    expect(explicit.ok).toBe(false);
    expect(explicit.summary).toContain('native writer that is unavailable');
    expect(explicit.stages.at(-1)).toMatchObject({ status: 'unsupported', code: 'nanite_mutation_unavailable' });
    expect(ue.calls.map((call) => call.cmd)).toEqual(['world_inspect', 'mesh_get_info']);

    const optional = await invoke('asset_prepare', {
      assetPath: '/Game/Terrain/SM_Tile', policy: { intent: 'terrain', nanite: 'auto', lods: { count: 2, reduction: 0.5 } },
    });
    expect(optional.ok).toBe(true);
    expect(optional.summary).toContain('Supported LOD reductions applied');
    expect(ue.paramsFor('mesh_set_lod')).toEqual({
      path: '/Game/Terrain/SM_Tile', lod_index: 1, screen_size: 0.5, reduction_percent_triangles: 0.5,
    });
    expect(ue.calls.map((call) => call.cmd)).toEqual(['world_inspect', 'mesh_get_info', 'mesh_get_info', 'mesh_set_lod']);
  });

  it.each([
    [{ partition: { mode: 'require', runtimeGrid: { name: 'Main', cellSize: 12800 } } }, 'world_partition_configuration_unavailable'],
    [{ partition: { mode: 'configure', hlod: { build: 'require' } } }, 'hlod_unavailable'],
    [{ materials: { mode: 'require' } }, 'material_creation_unavailable'],
  ])('refuses unavailable require policies with zero mutations: %s', async (policy, code) => {
    ue = scriptedUe().replies('world_inspect', world);
    const result = await invoke('world_ingest', { ...heightmap, ...policy });
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'plan', status: 'unsupported', code });
    expect(result.verdicts).toContainEqual(expect.objectContaining({ code, severity: 'error', direction: 'block' }));
    expect(result.affectedResources).toEqual([]);
    expect(ue.calls.map((call) => call.cmd)).toEqual(['world_inspect']);
  });

  it('returns structured partial failure and retained resources after import throws, without saving or retrying', async () => {
    ue = importableWorld(() => { throw new Error('Importer failed after spawning'); });
    const result = await invoke('world_ingest', heightmap);
    expect(result.ok).toBe(false);
    expect(result.operationId).toMatch(/^world-ingest:.+/);
    expect(result.stages.at(-1)).toMatchObject({
      stage: 'terrain', status: 'failed', code: 'terrain_import_failed', affectedResources: [landscape],
    });
    expect(result.affectedResources).toEqual([landscape]);
    expect(result.verdicts).toContainEqual(expect.objectContaining({ code: 'terrain_import_failed', direction: 'block' }));
    expect(result.remediation).toContainEqual(expect.objectContaining({ code: 'inspect_before_retry' }));
    expect(result.undo?.supported).toBe(false);
    expect(ue.calls.map((call) => call.cmd)).toEqual(['world_inspect', 'landscape_import', 'world_inspect']);
  });

  it.each(['before inspection', 'after import'] as const)('stops at a stage boundary on programmatic cancellation %s', async (when) => {
    const controller = new AbortController();
    ue = importableWorld(() => controller.abort());
    if (when === 'before inspection') controller.abort();
    // AbortSignal is the exported coordinator seam; the public MCP descriptor
    // currently has no cancellation field or session-signal integration.
    const result = WorkflowResultSchema.parse(await runWorldIngest(heightmap, {
      ...createNativeWorldIngestDependencies(), signal: controller.signal,
    }));
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({
      stage: when === 'before inspection' ? 'inspect' : 'partition', status: 'skipped', code: 'cancelled',
    });
    expect(result.affectedResources).toEqual(when === 'before inspection' ? [] : [landscape]);
    expect(result.verdicts).toContainEqual(expect.objectContaining({ code: 'cancelled', severity: 'error', direction: 'block' }));
    expect(result.undo?.supported).toBe(false);
    expect(ue.calls.map((call) => call.cmd)).toEqual(when === 'before inspection'
      ? [] : ['world_inspect', 'landscape_import', 'world_inspect']);
  });
});
