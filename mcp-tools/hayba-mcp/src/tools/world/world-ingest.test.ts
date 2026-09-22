import { afterEach, describe, expect, it, vi } from 'vitest';
import { stageResult, WorkflowResultSchema, type WorldIngestRequest } from '../workflows/contracts.js';
import { normalizeWorldFacts } from './world-inspect.js';
import { runWorldIngest, worldIngestDescriptor, type WorldIngestDependencies } from './world-ingest.js';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';

let ue: ScriptedUe | undefined;
afterEach(() => { ue?.restore(); ue = undefined; });

const nativeWorld = {
  world: { type: 'Editor', current_level: '/Game/Maps/Test', coordinate_system: 'left_handed_z_up_centimeters', scale: 100 },
  landscape: [], partition: { enabled: false, runtime_grids: [] }, data_layers: [],
  hlod: { layers: [] }, capabilities: { world_partition: true, hlod: true, web_browser: false }, save_ready: true,
};

const request: WorldIngestRequest = {
  source: { kind: 'heightmap', path: 'D:/terrain.r16' },
  destination: { mode: 'open_world' },
  partition: { mode: 'preserve' },
};
const landscape = { kind: 'landscape', id: 'Landscape_1', path: '/Game/Maps/Test.Test:PersistentLevel.Landscape_1' };
const mesh = { kind: 'asset', id: '/Game/Terrain/Tile', path: '/Game/Terrain/Tile' };

function fixture() {
  const report = normalizeWorldFacts(nativeWorld);
  report.facts.worldPartition.enabled = true;
  const dependencies = {
    inspectWorld: vi.fn(async () => report),
    importTerrain: vi.fn(async () => stageResult('terrain', 'succeeded', { affectedResources: [landscape] })),
    configurePartition: vi.fn(async () => stageResult('partition')),
    configureHlod: vi.fn(async () => stageResult('hlod')),
    prepareAsset: vi.fn(async () => ({
      ok: true, operationId: 'asset:tile', summary: 'Prepared tile', stages: [stageResult('prepare')],
      affectedResources: [mesh], verdicts: [], remediation: [],
    })),
    saveAndVerify: vi.fn(async () => stageResult('saveVerify')),
    validateWorld: vi.fn(async () => stageResult('validate')),
  } satisfies WorldIngestDependencies;
  return { dependencies, report };
}

describe('runWorldIngest', () => {
  it('refuses hard asset requirements before import when preparation support is absent', async () => {
    const { dependencies } = fixture();
    const result = await runWorldIngest({ ...request, assets: { intent: 'terrain', lightmapUvs: 'require' } }, {
      ...dependencies, prepareAsset: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'plan', status: 'unsupported', code: 'asset_preparation_unavailable' });
    expect(dependencies.importTerrain).not.toHaveBeenCalled();
  });

  it('records unsupported material creation and skips mesh preparation when no mesh was imported', async () => {
    const { dependencies } = fixture();
    const result = await runWorldIngest({ ...request, assets: { intent: 'terrain' }, materials: { mode: 'create' } }, dependencies);
    expect(result.ok).toBe(true);
    expect(result.stages.find((stage) => stage.stage === 'assets')).toMatchObject({ status: 'unsupported', code: 'material_creation_unavailable' });
    expect(dependencies.prepareAsset).not.toHaveBeenCalled();
  });

  it('records asset preparation resources and a child failure without saving', async () => {
    const { dependencies } = fixture();
    dependencies.importTerrain.mockResolvedValue(stageResult('terrain', 'succeeded', { affectedResources: [mesh] }));
    dependencies.prepareAsset.mockResolvedValue({
      ok: false, operationId: 'prepare:tile', summary: 'Required UVs unavailable',
      stages: [stageResult('prepare', 'unsupported')], affectedResources: [mesh], verdicts: [], remediation: [],
    });
    const result = await runWorldIngest({ ...request, assets: { intent: 'terrain', lightmapUvs: 'require' } }, dependencies);
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'assets', status: 'failed', affectedResources: [mesh] });
    expect(dependencies.saveAndVerify).not.toHaveBeenCalled();
  });

  it('cancellation before the workflow avoids even inspection', async () => {
    const { dependencies } = fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await runWorldIngest(request, { ...dependencies, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.stages).toHaveLength(1);
    expect(result.stages[0]).toMatchObject({ stage: 'inspect', code: 'cancelled' });
    expect(dependencies.inspectWorld).not.toHaveBeenCalled();
  });

  it('does not report an incomplete dependency stage as a completed ingestion', async () => {
    const { dependencies } = fixture();
    dependencies.importTerrain.mockResolvedValue(stageResult('terrain', 'running', { affectedResources: [landscape] }));
    const result = await runWorldIngest(request, dependencies);
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'terrain', status: 'failed', code: 'stage_incomplete' });
    expect(result.affectedResources).toEqual([landscape]);
    expect(dependencies.saveAndVerify).not.toHaveBeenCalled();
  });

  it.each(['pending', 'running'] as const)('stops before HLOD and saving when partition configuration returns %s', async (status) => {
    const { dependencies } = fixture();
    const grid = { kind: 'runtime_grid', id: 'Main' };
    dependencies.configurePartition.mockResolvedValue(stageResult('partition', status, { affectedResources: [grid] }));
    const result = await runWorldIngest({
      ...request, partition: { mode: 'configure', runtimeGrid: { name: 'Main' }, hlod: { build: 'auto' } },
    }, dependencies);
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({
      stage: 'partition', status: 'failed', code: 'stage_incomplete', affectedResources: [grid],
    });
    expect(result.affectedResources).toEqual([landscape, grid]);
    expect(dependencies.configureHlod).not.toHaveBeenCalled();
    expect(dependencies.saveAndVerify).not.toHaveBeenCalled();
    expect(dependencies.validateWorld).not.toHaveBeenCalled();
  });

  it.each(['pending', 'running'] as const)('retains partition and HLOD resources without saving when HLOD returns %s', async (status) => {
    const { dependencies } = fixture();
    const grid = { kind: 'runtime_grid', id: 'Main' };
    const hlod = { kind: 'hlod_layer', id: 'Terrain' };
    dependencies.configurePartition.mockResolvedValue(stageResult('partition', 'succeeded', { affectedResources: [grid] }));
    dependencies.configureHlod.mockResolvedValue(stageResult('hlod', status, { affectedResources: [hlod] }));
    const result = await runWorldIngest({
      ...request, partition: { mode: 'configure', runtimeGrid: { name: 'Main' }, hlod: { build: 'auto' } },
    }, dependencies);
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({
      stage: 'partition', status: 'failed', code: 'stage_incomplete', affectedResources: [grid, hlod],
    });
    expect(result.affectedResources).toEqual([landscape, grid, hlod]);
    expect(dependencies.saveAndVerify).not.toHaveBeenCalled();
    expect(dependencies.validateWorld).not.toHaveBeenCalled();
  });

  it('refuses malformed inspection before import', async () => {
    const { dependencies } = fixture();
    dependencies.inspectWorld.mockResolvedValue(normalizeWorldFacts({}));
    const result = await runWorldIngest(request, dependencies);
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)?.code).toBe('world_inspect_malformed');
    expect(dependencies.importTerrain).not.toHaveBeenCalled();
  });

  it('reports unavailable optional validation but refuses required validation before importing', async () => {
    const { dependencies } = fixture();
    const report = await runWorldIngest(request, { ...dependencies, validateWorld: undefined });
    expect(report.ok).toBe(true);
    expect(report.stages.at(-1)).toMatchObject({ status: 'unsupported', code: 'validation_unavailable' });
    dependencies.importTerrain.mockClear();
    const required = await runWorldIngest({ ...request, validation: { mode: 'require' } }, { ...dependencies, validateWorld: undefined });
    expect(required.ok).toBe(false);
    expect(dependencies.importTerrain).not.toHaveBeenCalled();
  });

  it('does not save after an unsupported terrain import', async () => {
    const { dependencies } = fixture();
    dependencies.importTerrain.mockResolvedValue(stageResult('terrain', 'unsupported', { code: 'source_unavailable' }));
    const result = await runWorldIngest(request, dependencies);
    expect(result.ok).toBe(false);
    expect(dependencies.saveAndVerify).not.toHaveBeenCalled();
  });

  it('retains partition changes if the HLOD dependency throws', async () => {
    const { dependencies } = fixture();
    const grid = { kind: 'runtime_grid', id: 'Main' };
    dependencies.configurePartition.mockResolvedValue(stageResult('partition', 'succeeded', { affectedResources: [grid] }));
    dependencies.configureHlod.mockRejectedValue(new Error('HLOD failed'));
    const result = await runWorldIngest({ ...request, partition: { mode: 'configure', runtimeGrid: { name: 'Main' }, hlod: { build: 'auto' } } }, dependencies);
    expect(result.ok).toBe(false);
    expect(result.affectedResources).toEqual([landscape, grid]);
    expect(result.stages.at(-1)?.affectedResources).toEqual([grid]);
  });

  it('retains resources from a partially failed import and never attempts save', async () => {
    const { dependencies } = fixture();
    dependencies.importTerrain.mockResolvedValue(stageResult('terrain', 'failed', {
      code: 'import_partial', affectedResources: [landscape], remediation: [{ code: 'inspect_partial', label: 'Inspect imported terrain' }],
    }));
    const result = await runWorldIngest(request, dependencies);
    expect(result.ok).toBe(false);
    expect(result.affectedResources).toEqual([landscape]);
    expect(result.remediation).toEqual([{ code: 'inspect_partial', label: 'Inspect imported terrain' }]);
    expect(dependencies.saveAndVerify).not.toHaveBeenCalled();
  });

  it('returns save exceptions as a failed stage while retaining imported resources', async () => {
    const { dependencies } = fixture();
    dependencies.saveAndVerify.mockRejectedValue(new Error('Disk is full'));
    const result = await runWorldIngest(request, dependencies);
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'saveVerify', status: 'failed', summary: 'Disk is full' });
    expect(result.affectedResources).toEqual([landscape]);
    expect(dependencies.validateWorld).not.toHaveBeenCalled();
  });

  it('stops at the next stage boundary when import completes after cancellation', async () => {
    const { dependencies } = fixture();
    const controller = new AbortController();
    dependencies.importTerrain.mockImplementation(async () => {
      controller.abort();
      return stageResult('terrain', 'succeeded', { affectedResources: [landscape] });
    });
    const result = await runWorldIngest({ ...request, partition: { mode: 'configure', runtimeGrid: { name: 'Main' } } }, {
      ...dependencies, signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'partition', status: 'skipped', code: 'cancelled' });
    expect(result.affectedResources).toEqual([landscape]);
    expect(dependencies.configurePartition).not.toHaveBeenCalled();
    expect(dependencies.saveAndVerify).not.toHaveBeenCalled();
  });

  it('preserves completed asset work when preparation of another imported mesh fails', async () => {
    const { dependencies } = fixture();
    const other = { kind: 'asset', id: '/Game/Terrain/Other' };
    dependencies.importTerrain.mockResolvedValue(stageResult('terrain', 'succeeded', { affectedResources: [landscape, mesh, other] }));
    dependencies.prepareAsset.mockResolvedValueOnce({
      ok: true, operationId: 'prepare:tile', summary: 'Prepared', stages: [stageResult('prepare')],
      affectedResources: [mesh], verdicts: [], remediation: [],
    }).mockRejectedValueOnce(new Error('Mesh preparation failed'));
    const result = await runWorldIngest({ ...request, assets: { intent: 'terrain' } }, dependencies);
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'assets', status: 'failed' });
    expect(result.affectedResources).toEqual([landscape, mesh, other]);
    expect(dependencies.saveAndVerify).not.toHaveBeenCalled();
  });

  it('require stops before terrain when World Partition support is absent', async () => {
    const { dependencies, report } = fixture();
    report.facts.capabilities.worldPartition = false;
    const result = await runWorldIngest({ ...request, partition: { mode: 'require' } }, dependencies);
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'plan', status: 'unsupported', code: 'world_partition_unavailable' });
    expect(dependencies.importTerrain).not.toHaveBeenCalled();
  });

  it('require stops before terrain when the engine feature exists but no configuration writer exists', async () => {
    const { dependencies } = fixture();
    const result = await runWorldIngest({ ...request, partition: { mode: 'require', runtimeGrid: { cellSize: 12800 } } }, {
      ...dependencies, configurePartition: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)?.code).toBe('world_partition_configuration_unavailable');
    expect(dependencies.importTerrain).not.toHaveBeenCalled();
  });

  it('configure records unsupported optional HLOD and still saves and validates', async () => {
    const { dependencies, report } = fixture();
    report.facts.capabilities.hlod = false;
    const result = await runWorldIngest({ ...request, partition: { mode: 'configure', hlod: { build: 'auto' } } }, dependencies);
    expect(result.ok).toBe(true);
    expect(result.stages.find((stage) => stage.stage === 'partition')).toMatchObject({ status: 'unsupported', code: 'hlod_unavailable' });
    expect(dependencies.configureHlod).not.toHaveBeenCalled();
    expect(dependencies.saveAndVerify).toHaveBeenCalledOnce();
    expect(dependencies.validateWorld).toHaveBeenCalledOnce();
    expect(result.verdicts).toContainEqual(expect.objectContaining({ code: 'hlod_unavailable', severity: 'warning', direction: 'review' }));
  });

  it('required HLOD stops before import even under configure', async () => {
    const { dependencies, report } = fixture();
    report.facts.capabilities.hlod = false;
    const result = await runWorldIngest({ ...request, partition: { mode: 'configure', hlod: { build: 'require' } } }, dependencies);
    expect(result.ok).toBe(false);
    expect(dependencies.importTerrain).not.toHaveBeenCalled();
  });

  it('dry run returns the plan and never imports, configures, prepares, saves, or validates', async () => {
    const { dependencies } = fixture();
    const result = await runWorldIngest({
      ...request, assets: { intent: 'terrain' }, partition: { mode: 'configure', hlod: { build: 'auto' } },
      execution: { dryRun: true },
    }, dependencies);
    expect(result.ok).toBe(true);
    expect(result.stages.slice(0, 3).map((stage) => stage.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(result.stages.find((stage) => stage.stage === 'plan')?.summary).toContain('heightmap');
    expect(result.stages.slice(3).every((stage) => stage.status === 'skipped')).toBe(true);
    expect(result.affectedResources).toEqual([]);
    for (const method of ['importTerrain', 'configurePartition', 'configureHlod', 'prepareAsset', 'saveAndVerify', 'validateWorld'] as const) {
      expect(dependencies[method]).not.toHaveBeenCalled();
    }
  });

  it('returns the ordered stages and imported resources in the public workflow contract', async () => {
    const { dependencies } = fixture();
    const result = await runWorldIngest(request, dependencies);
    expect(result.ok).toBe(true);
    expect(result.stages.map((stage) => stage.stage)).toEqual([
      'inspect', 'normalize', 'plan', 'terrain', 'partition', 'assets', 'saveVerify', 'validate',
    ]);
    expect(result.affectedResources).toEqual([landscape]);
    expect(WorkflowResultSchema.safeParse(result).success).toBe(true);
  });
});

describe('worldIngestDescriptor native adapter', () => {
  it.each([
    { source: { kind: 'mesh_terrain', path: '/Game/Terrain' } },
    { source: { kind: 'landscape_export', path: 'D:/landscape.json' } },
    { source: { kind: 'connector_artifact', connector: 'gaea', artifactId: 'tile-1' } },
    { destination: { mode: 'managed_update', importId: 'existing-import' } },
    { destination: { mode: 'new_world', path: '/Game/Maps/New' } },
    { terrain: { scale: [100, 200, 300] } },
    { materials: { mode: 'require' } },
    { execution: { planMode: true } },
  ])('refuses unsupported native requests before importing: %j', async (options) => {
    ue = scriptedUe().replies('world_inspect', nativeWorld);
    const response = await worldIngestDescriptor.handler({ ...request, ...options }, {});
    const result = WorkflowResultSchema.parse(JSON.parse(response.content.find((block) => block.type === 'text')!.text));
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)?.status).toBe('unsupported');
    expect(ue.calls.map((call) => call.cmd)).toEqual(['world_inspect']);
  });

  it('does not accept a silent importer success as evidence that terrain exists', async () => {
    ue = scriptedUe().replies('world_inspect', nativeWorld).silentlySucceeds('landscape_import');
    const response = await worldIngestDescriptor.handler(request, {});
    const result = WorkflowResultSchema.parse(JSON.parse(response.content.find((block) => block.type === 'text')!.text));
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)?.code).toBe('terrain_not_verified');
    expect(ue.called('level_save')).toBe(false);
  });

  it('native dry run exposes importer defaults and makes only the inspection call', async () => {
    ue = scriptedUe().replies('world_inspect', nativeWorld);
    const response = await worldIngestDescriptor.handler({ ...request, execution: { dryRun: true } }, {});
    const result = WorkflowResultSchema.parse(JSON.parse(response.content.find((block) => block.type === 'text')!.text));
    expect(result.ok).toBe(true);
    const plan = JSON.parse(result.stages.find((stage) => stage.stage === 'plan')!.summary!);
    expect(plan.request.terrain).toEqual({ worldSizeKm: 8, maxHeightM: 600, actorLabel: 'Hayba_Terrain' });
    expect(ue.calls.map((call) => call.cmd)).toEqual(['world_inspect']);
  });

  it('passes terrain dimensions and label to the existing importer and verifies the created landscape', async () => {
    let imported = false;
    ue = scriptedUe()
      .replies('world_inspect', () => ({ ...nativeWorld, landscape: imported ? [{ name: 'Landscape_1', path: landscape.path, label: 'Mountain' }] : [] }))
      .replies('landscape_import', () => { imported = true; return { actorLabel: 'Mountain' }; })
      .replies('level_save', { saved: true, verified: true, dirty: false });
    const response = await worldIngestDescriptor.handler({
      ...request, terrain: { worldSizeKm: 2.5, maxHeightM: 350, actorLabel: 'Mountain', material: '/Game/Materials/Terrain' },
    }, {});
    const result = WorkflowResultSchema.parse(JSON.parse(response.content.find((block) => block.type === 'text')!.text));
    expect(result.ok).toBe(true);
    expect(ue.paramsFor('landscape_import')).toEqual({
      heightmapPath: 'D:/terrain.r16', worldSizeKm: 2.5, maxHeightM: 350, actorLabel: 'Mountain', landscapeMaterial: '/Game/Materials/Terrain',
    });
    expect(result.affectedResources).toContainEqual({ kind: 'landscape', id: landscape.path, path: landscape.path });
  });

  it('reports unsupported persistence for native partitioned-world external actors', async () => {
    let imported = false;
    ue = scriptedUe()
      .replies('world_inspect', () => ({ ...nativeWorld, partition: { enabled: true, runtime_grids: [] },
        landscape: imported ? [{ path: landscape.path, label: 'Hayba_Terrain' }] : [],
      }))
      .replies('landscape_import', () => { imported = true; return { actorLabel: 'Hayba_Terrain' }; });
    const response = await worldIngestDescriptor.handler(request, {});
    const result = WorkflowResultSchema.parse(JSON.parse(response.content.find((block) => block.type === 'text')!.text));
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'saveVerify', status: 'unsupported', code: 'external_actor_persistence_unavailable' });
    expect(result.affectedResources).toContainEqual({ kind: 'landscape', id: landscape.path, path: landscape.path });
  });

  it('retains new landscapes observed after a native import error', async () => {
    let imported = false;
    ue = scriptedUe()
      .replies('world_inspect', () => ({ ...nativeWorld, landscape: imported ? [{ path: landscape.path }] : [] }))
      .replies('landscape_import', () => { imported = true; throw new Error('Import failed after spawning'); });
    const response = await worldIngestDescriptor.handler(request, {});
    const result = WorkflowResultSchema.parse(JSON.parse(response.content.find((block) => block.type === 'text')!.text));
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'terrain', status: 'failed' });
    expect(result.affectedResources).toContainEqual({ kind: 'landscape', id: landscape.path, path: landscape.path });
    expect(ue.called('level_save')).toBe(false);
  });

  it('does not accept a save reply without verified clean-package readback', async () => {
    let imported = false;
    ue = scriptedUe()
      .replies('world_inspect', () => ({ ...nativeWorld, landscape: imported ? [{ path: landscape.path }] : [] }))
      .replies('landscape_import', () => { imported = true; return {}; })
      .replies('level_save', { saved: true });
    const response = await worldIngestDescriptor.handler(request, {});
    const result = WorkflowResultSchema.parse(JSON.parse(response.content.find((block) => block.type === 'text')!.text));
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'saveVerify', status: 'failed' });
    expect(result.affectedResources).toHaveLength(1);
  });
});
