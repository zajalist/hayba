// mcp-tools/hayba-mcp/src/slivers/scatter/pcg_biome.ts
//
// Side-effecting executor: builds a minimal PCG graph that scatters a
// StaticMesh across the surface of an area actor, then asks UE to build
// it. The graph itself is the deterministic abstraction — same params
// produce the same PCGGraphJSON, so the LLM gets a reproducible scatter
// without having to construct the topology by hand.
//
// Topology (standard PCG, not PCGEx — uses In/Out pin names per
// graph-patterns.ts):
//
//     [PCGDataFromActorSettings]  -- Out --> In [PCGSurfaceSamplerSettings]
//                                                            |
//                                                          Out
//                                                            v
//                                          In [PCGStaticMeshSpawnerSettings]
//
// Determinism: the spec's `seed` param is written onto PCGSurfaceSampler's
// Seed property; PCG samples deterministically from there.

import type { SliverExecutor } from '../types.js';
import type { PCGGraphJSON, PCGNode, PCGEdge } from '../../types.js';

export const SCATTER_PCG_BIOME_KIND = 'scatter.pcg_biome';

interface PcgBiomeParams {
  area_actor: string;
  mesh: string;
  density: number;
  scale_min: number;
  scale_max: number;
  yaw_jitter: number;
  seed: number;
  graph_name: string;
}

/** One-time-stamped graph asset name so successive runs do not collide. */
function uniqueGraphName(base: string, seed: number): string {
  const stamp = Date.now().toString(36);
  return `${base}_${seed}_${stamp}`;
}

function node(
  id: string, klass: string, label: string,
  x: number, y: number,
  properties: Record<string, unknown> = {},
): PCGNode {
  return { id, class: klass, label, position: { x, y }, properties, customData: {} };
}

function edge(fromNode: string, toNode: string, fromPin = 'Out', toPin = 'In'): PCGEdge {
  return { fromNode, fromPin, toNode, toPin };
}

/** Build the PCGGraphJSON for one biome-scatter run. Pure — returned graph
 *  is determined entirely by the supplied params. */
export function buildBiomeScatterGraph(p: PcgBiomeParams): PCGGraphJSON {
  const actorSource: PCGNode = node(
    'actor', 'PCGDataFromActorSettings', 'Area Actor',
    0, 0,
    // GetSinglePoint mode per graph-patterns.ts — we want the actor's
    // bounds as a single point seed to feed the sampler.
    { Mode: 'GetSinglePoint', ActorReference: p.area_actor },
  );
  const sampler: PCGNode = node(
    'sampler', 'PCGSurfaceSamplerSettings', 'Surface Sample',
    260, 0,
    {
      PointsPerSquaredMeter: p.density,
      Seed: p.seed,
    },
  );
  const spawner: PCGNode = node(
    'spawner', 'PCGStaticMeshSpawnerSettings', 'Spawn Mesh',
    520, 0,
    {
      // Structured mesh binding: the native create_graph handler special-cases
      // UPCGStaticMeshSpawnerSettings and populates its read-only weighted
      // MeshSelectorParameters from this array. A bare `Mesh` string never
      // bound (the export-text path came back null), so we always emit the
      // structured form.
      MeshEntries: [{ mesh: p.mesh, weight: 1 }],
      ScaleMin: p.scale_min,
      ScaleMax: p.scale_max,
      YawJitter: p.yaw_jitter,
    },
  );

  return {
    version: '2',
    meta: {
      sourceGraph: p.graph_name,
      ueVersion: '5.7',
      exportedAt: new Date().toISOString(),
      tags: ['hayba.sliver', 'scatter.pcg_biome'],
    },
    nodes: [actorSource, sampler, spawner],
    edges: [
      edge('actor', 'sampler'),
      edge('sampler', 'spawner'),
    ],
    metadata: {},
  } as PCGGraphJSON;
}

export const pcgBiomeExecutor: SliverExecutor = async (rawParams, ctx) => {
  const p = rawParams as unknown as PcgBiomeParams;

  if (!ctx.dispatch) {
    throw new Error(
      'pcg_biome requires a UE bridge — setupSliverSystem({ ueBridge }) was not wired',
    );
  }

  const graphName = uniqueGraphName(p.graph_name, p.seed);
  const graph = buildBiomeScatterGraph({ ...p, graph_name: graphName });

  const created = await ctx.dispatch('create_graph', { graph, name: graphName });
  if (!created.ok) {
    throw new Error(`pcg_biome: create_graph failed — ${created.error ?? 'unknown error'}`);
  }
  const assetPath =
    (created.data?.assetPath as string | undefined)
    ?? (created.data?.path as string | undefined)
    ?? `/Game/PCG/${graphName}.${graphName}`;

  const executed = await ctx.dispatch('execute_graph', { assetPath });
  if (!executed.ok) {
    throw new Error(`pcg_biome: execute_graph failed — ${executed.error ?? 'unknown error'}`);
  }

  return {
    graph_asset: assetPath,
    create_result: created.data ?? {},
    execute_result: executed.data ?? {},
  };
};
