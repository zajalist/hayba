import { describe, expect, it } from 'vitest';
import { getSidecar } from '../../legacy-commands/index.js';
import { InMemoryToolExecutor, setDefaultSender } from '../tool-executor.js';
import { normalizeWorldFacts, worldInspectDescriptor } from './world-inspect.js';

// Canonical native wire payload: the public report deliberately uses camelCase.
function snapshot(enabled = true) {
  return {
    world: {
      type: 'Editor', current_level: '/Game/Maps/OpenWorld',
      coordinate_system: 'left_handed_z_up_centimeters', scale: 100,
      source_control_ready: false,
    },
    landscape: enabled ? [{ name: 'Landscape_Main' }] : [],
    partition: { enabled, runtime_grids: enabled ? ['MainGrid'] : [], enumeration_scope: 'loaded_actors' },
    data_layers: enabled ? ['Gameplay'] : [],
    hlod: { layers: enabled ? ['/Game/MainHLOD.MainHLOD'] : [], enumeration_scope: 'loaded_actors_and_world_default' },
    capabilities: { world_partition: true, hlod: true, web_browser: true },
    save_ready: true,
  };
}

describe('normalizeWorldFacts', () => {
  it('normalizes the native grouped snapshot into the public capability report', () => {
    const report = normalizeWorldFacts(snapshot());
    expect(report.facts).toEqual({
      worldType: 'Editor', currentLevel: '/Game/Maps/OpenWorld',
      landscapeActors: [{ name: 'Landscape_Main' }],
      worldPartition: { enabled: true, runtimeGrids: ['MainGrid'], dataLayers: ['Gameplay'], hlodLayers: ['/Game/MainHLOD.MainHLOD'] },
      coordinateSystem: 'left_handed_z_up_centimeters', scale: 100,
      sourceControlReady: false, saveReady: true,
      capabilities: { webBrowser: true, worldPartition: true, hlod: true },
    });
    expect(report.blockingErrors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.recommendedDefaults.partition.mode).toBe('preserve');
  });

  it('recommends configuration for an empty non-partitioned world', () => {
    const report = normalizeWorldFacts(snapshot(false));
    expect(report.facts.worldPartition).toEqual({ enabled: false, runtimeGrids: [], dataLayers: [], hlodLayers: [] });
    expect(report.facts.landscapeActors).toEqual([]);
    expect(report.blockingErrors).toEqual([]);
    expect(report.recommendedDefaults.partition.mode).toBe('configure');
  });

  it('reports unavailable capabilities with stable codes', () => {
    const report = normalizeWorldFacts({ ...snapshot(false), capabilities: { world_partition: false, hlod: false, web_browser: false } });
    expect(report.blockingErrors.map((result) => result.code)).toContain('world_partition_unavailable');
    expect(report.warnings.map((result) => result.code)).toEqual(['hlod_unavailable', 'web_browser_unavailable']);
  });

  it.each([
    'World Partition is probably available',
    { ...snapshot(), capabilities: { world_partition: true, hlod: true, web_browser: 'true' } },
    { ...snapshot(), partition: {} },
    { ...snapshot(), landscape: undefined },
    { ...snapshot(), data_layers: undefined },
    { ...snapshot(), hlod: undefined },
  ])('blocks malformed native snapshots', (raw) => {
    expect(normalizeWorldFacts(raw).blockingErrors.map((result) => result.code)).toContain('world_inspect_malformed');
  });
});

describe('worldInspectDescriptor', () => {
  it('executes world_inspect and normalizes its native grouped response', async () => {
    const executor = new InMemoryToolExecutor().on('world_inspect', (params) => {
      expect(params).toEqual({});
      return { ok: true, data: snapshot() };
    });
    setDefaultSender(executor.send);
    try {
      const result = await worldInspectDescriptor.handler({}, {} as never);
      const content = result.content[0];
      if (content.type !== 'text') throw new Error('world_inspect must return text content');
      expect(JSON.parse(content.text)).toMatchObject({ facts: { worldPartition: { enabled: true } }, blockingErrors: [] });
    } finally {
      setDefaultSender(undefined as never);
    }
  });

  it('documents the native grouped result without generating a duplicate legacy wrapper', () => {
    const entry = getSidecar().commands.world_inspect;
    expect(entry).toMatchObject({ agent_callable: true, has_ts_wrapper: true, params: [] });
    expect(entry.returns.fields?.map((field) => field.name)).toEqual([
      'world', 'landscape', 'partition', 'data_layers', 'hlod', 'capabilities', 'save_ready',
    ]);
  });
});
