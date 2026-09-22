import { describe, expect, it } from 'vitest';
import { InMemoryToolExecutor, setDefaultSender } from '../tool-executor.js';
import {
  normalizeWorldFacts,
  worldInspectDescriptor,
} from './world-inspect.js';

describe('normalizeWorldFacts', () => {
  it('normalizes an explicitly partitioned world without inventing capability gaps', () => {
    const report = normalizeWorldFacts({
      worldType: 'OpenWorld',
      currentLevel: '/Game/Maps/OpenWorld',
      landscapeActors: [{ name: 'Landscape_Main', bounds: [0, 0, 1000, 1000] }],
      isPartitioned: true,
      supportsWorldPartition: true,
      supportsHlod: true,
      hasWebBrowser: true,
      runtimeGrids: ['MainGrid'],
      dataLayers: ['Gameplay'],
      hlodLayers: ['MainHLOD'],
    });

    expect(report.facts.worldPartition).toMatchObject({ enabled: true, runtimeGrids: ['MainGrid'] });
    expect(report.blockingErrors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.recommendedDefaults).toMatchObject({ partition: { mode: 'preserve' } });
  });

  it('recommends configuration for a non-partitioned world when support is reported', () => {
    const report = normalizeWorldFacts({
      isPartitioned: false,
      supportsWorldPartition: true,
      supportsHlod: true,
      hasWebBrowser: true,
      runtimeGrids: [],
      dataLayers: [],
      hlodLayers: [],
    });

    expect(report.facts.worldPartition.enabled).toBe(false);
    expect(report.blockingErrors).toEqual([]);
    expect(report.recommendedDefaults).toMatchObject({ partition: { mode: 'configure' } });
  });

  it('reports missing WebBrowser and World Partition support with stable codes', () => {
    const report = normalizeWorldFacts({
      isPartitioned: false,
      supportsWorldPartition: false,
      supportsHlod: false,
      hasWebBrowser: false,
      runtimeGrids: [],
      dataLayers: [],
      hlodLayers: [],
    });

    expect(report.blockingErrors.map((result) => result.code)).toContain('world_partition_unavailable');
    expect(report.warnings.map((result) => result.code)).toEqual(
      expect.arrayContaining(['web_browser_unavailable', 'hlod_unavailable']),
    );
  });

  it('treats malformed UE output as a blocking inspection failure', () => {
    const report = normalizeWorldFacts('World Partition is probably available');

    expect(report.blockingErrors.map((result) => result.code)).toContain('world_inspect_malformed');
    expect(report.facts.worldPartition.enabled).toBe(false);
  });
});

describe('worldInspectDescriptor', () => {
  it('executes only the world_inspect UE command and returns normalized facts', async () => {
    const executor = new InMemoryToolExecutor().on('world_inspect', (params) => {
      expect(params).toEqual({});
      return {
        ok: true,
        data: {
          isPartitioned: true,
          supportsWorldPartition: true,
          supportsHlod: true,
          hasWebBrowser: true,
          runtimeGrids: ['MainGrid'],
          dataLayers: [],
          hlodLayers: [],
        },
      };
    });
    setDefaultSender(executor.send);

    const result = await worldInspectDescriptor.handler({}, {} as never);

    expect(worldInspectDescriptor.name).toBe('world_inspect');
    const content = result.content[0];
    expect(content.type).toBe('text');
    if (content.type !== 'text') throw new Error('world_inspect must return text content');
    expect(JSON.parse(content.text)).toMatchObject({
      facts: { worldPartition: { enabled: true } },
    });
  });
});
