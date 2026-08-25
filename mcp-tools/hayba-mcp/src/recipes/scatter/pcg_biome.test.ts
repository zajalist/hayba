import { describe, it, expect } from 'vitest';
import { pcgBiomeExecutor, buildBiomeScatterGraph } from './pcg_biome.js';
import type { RecipeContext, RecipeUeBridge } from '../types.js';

const baseParams = {
  area_actor: '/Game/Maps/Demo.BiomeVolume_0',
  mesh: '/Game/Foliage/SM_Pine',
  density: 0.5,
  scale_min: 0.9,
  scale_max: 1.2,
  yaw_jitter: 360,
  seed: 1337,
  graph_name: 'BiomeScatter',
};

function ctxWith(dispatch?: RecipeUeBridge): RecipeContext {
  return {
    stack: [], maxDepth: 8,
    runRecipe: async () => ({ ok: true, outputs: {}, side_effects: [], durationMs: 0 }),
    dispatch,
  };
}

describe('buildBiomeScatterGraph', () => {
  it('produces the 4-node In→Out topology (actor → sampler → transform → spawner)', () => {
    const g = buildBiomeScatterGraph({ ...baseParams, graph_name: 'Test_1337' });
    expect(g.nodes.map(n => n.id).sort()).toEqual(['actor', 'sampler', 'spawner', 'transform']);
    expect(g.edges).toEqual([
      { fromNode: 'actor',     fromPin: 'Out', toNode: 'sampler',   toPin: 'In' },
      { fromNode: 'sampler',   fromPin: 'Out', toNode: 'transform', toPin: 'In' },
      { fromNode: 'transform', fromPin: 'Out', toNode: 'spawner',   toPin: 'In' },
    ]);
  });

  it('inserts a deterministic transform node carrying scale + yaw jitter', () => {
    const g = buildBiomeScatterGraph({
      ...baseParams, scale_min: 0.8, scale_max: 1.4, yaw_jitter: 180, seed: 99, graph_name: 'X',
    });
    const t = g.nodes.find(n => n.id === 'transform')!;
    expect(t.class).toBe('PCGTransformPointsSettings');
    expect(t.properties.ScaleMin).toBe('(X=0.8,Y=0.8,Z=0.8)');
    expect(t.properties.ScaleMax).toBe('(X=1.4,Y=1.4,Z=1.4)');
    expect(t.properties.bUniformScale).toBe(true);
    expect(t.properties.bAbsoluteScale).toBe(false);
    expect(t.properties.RotationMin).toBe('(Pitch=0,Yaw=0,Roll=0)');
    expect(t.properties.RotationMax).toBe('(Pitch=0,Yaw=180,Roll=0)');
    expect(t.properties.bAbsoluteRotation).toBe(false);
    expect(t.properties.Seed).toBe(99);
  });

  it('threads seed + density into the surface sampler', () => {
    const g = buildBiomeScatterGraph({ ...baseParams, density: 0.7, seed: 4242, graph_name: 'X' });
    const sampler = g.nodes.find(n => n.id === 'sampler')!;
    expect(sampler.class).toBe('PCGSurfaceSamplerSettings');
    expect(sampler.properties.Seed).toBe(4242);
    expect(sampler.properties.PointsPerSquaredMeter).toBe(0.7);
  });

  it('binds the mesh on the spawner via MeshEntries (scale/yaw now live on the transform node)', () => {
    const g = buildBiomeScatterGraph({ ...baseParams, graph_name: 'X' });
    const spawner = g.nodes.find(n => n.id === 'spawner')!;
    expect(spawner.class).toBe('PCGStaticMeshSpawnerSettings');
    // Mesh is bound via the structured MeshEntries array, not a bare string.
    expect(spawner.properties.Mesh).toBeUndefined();
    expect(spawner.properties.MeshEntries).toEqual([{ mesh: '/Game/Foliage/SM_Pine', weight: 1 }]);
    // Scale/yaw are handled by the transform node, no longer dead props here.
    expect(spawner.properties.ScaleMin).toBeUndefined();
    expect(spawner.properties.ScaleMax).toBeUndefined();
    expect(spawner.properties.YawJitter).toBeUndefined();
  });

  it('refers to the area actor in GetSinglePoint mode', () => {
    const g = buildBiomeScatterGraph({ ...baseParams, graph_name: 'X' });
    const actor = g.nodes.find(n => n.id === 'actor')!;
    expect(actor.class).toBe('PCGDataFromActorSettings');
    expect(actor.properties.Mode).toBe('GetSinglePoint');
    expect(actor.properties.ActorReference).toBe('/Game/Maps/Demo.BiomeVolume_0');
  });
});

describe('pcgBiomeExecutor', () => {
  it('throws when no UE bridge is wired', async () => {
    await expect(pcgBiomeExecutor(baseParams, ctxWith(undefined))).rejects.toThrow(/ueBridge/i);
  });

  it('calls create_graph then execute_graph and returns the asset path', async () => {
    const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
    const dispatch: RecipeUeBridge = async (cmd, params) => {
      calls.push({ cmd, params });
      if (cmd === 'create_graph') return { ok: true, data: { assetPath: '/Game/PCG/MyGraph.MyGraph' } };
      if (cmd === 'execute_graph') return { ok: true, data: { instances: 42 } };
      return { ok: false, error: `unexpected cmd ${cmd}` };
    };
    const out = await pcgBiomeExecutor(baseParams, ctxWith(dispatch));
    expect(calls.map(c => c.cmd)).toEqual(['create_graph', 'execute_graph']);
    expect(out.graph_asset).toBe('/Game/PCG/MyGraph.MyGraph');
    expect((out.execute_result as { instances: number }).instances).toBe(42);

    // The create call carries a PCGGraphJSON whose seed matches the param.
    const createParams = calls[0].params as { graph: { nodes: Array<{ properties: Record<string, unknown> }> } };
    const samplerSeed = createParams.graph.nodes.find(n => (n.properties as { Seed?: number }).Seed != null);
    expect(samplerSeed?.properties.Seed).toBe(1337);
  });

  it('surfaces a create_graph failure as a thrown error', async () => {
    const dispatch: RecipeUeBridge = async (cmd) =>
      cmd === 'create_graph' ? { ok: false, error: 'asset name taken' } : { ok: true };
    await expect(pcgBiomeExecutor(baseParams, ctxWith(dispatch)))
      .rejects.toThrow(/create_graph failed.*asset name taken/);
  });

  it('surfaces an execute_graph failure as a thrown error', async () => {
    const dispatch: RecipeUeBridge = async (cmd) => cmd === 'create_graph'
      ? { ok: true, data: { assetPath: '/Game/PCG/G.G' } }
      : { ok: false, error: 'PCG runtime missing' };
    await expect(pcgBiomeExecutor(baseParams, ctxWith(dispatch)))
      .rejects.toThrow(/execute_graph failed.*PCG runtime missing/);
  });
});
