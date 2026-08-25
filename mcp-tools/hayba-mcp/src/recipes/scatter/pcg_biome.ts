// mcp-tools/hayba-mcp/src/recipes/scatter/pcg_biome.ts
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
//                                          In [PCGTransformPointsSettings]
//                                                            |
//                                                          Out
//                                                            v
//                                          In [PCGStaticMeshSpawnerSettings]
//
// The transform node breaks the "uniform clone" look: per point it multiplies
// scale by a uniform random factor in [scale_min, scale_max] and adds a random
// yaw in [0, yaw_jitter] degrees. Uniform clones read as fake; jitter reads as
// natural.
//
// Determinism: the spec's `seed` param is written onto BOTH the SurfaceSampler
// and the TransformPoints Seed property; PCG samples deterministically.

import type { RecipeExecutor } from '../types.js';
import type { PCGGraphJSON, PCGNode, PCGEdge } from '../../types.js';

export const SCATTER_PCG_BIOME_KIND = 'scatter.pcg_biome';

/** A weighted mesh entry for the StaticMeshSpawner's weighted selector. */
export interface MeshEntry {
  mesh: string;
  weight: number;
}

export interface PcgBiomeParams {
  area_actor: string;
  /** Single mesh path. Ignored when `meshes` is supplied. */
  mesh: string;
  /** Optional weighted list; overrides `mesh` when non-empty. */
  meshes?: MeshEntry[];
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
  // Per-point randomization. UPCGTransformPointsSettings (UE 5.8:
  // Engine/Plugins/PCG/Source/PCG/Public/Elements/PCGTransformPoints.h) is the
  // stock node for this. Property names verified against that header:
  //   - ScaleMin / ScaleMax   : FVector (multiplicative; bAbsoluteScale=false)
  //   - bUniformScale         : bool (true → uses the X component of Scale*)
  //   - RotationMin / RotationMax : FRotator (additive; bAbsoluteRotation=false)
  //   - Seed                  : inherited from UPCGSettings (UseSeed()==true)
  // FVector/FRotator are expressed as UE import-text strings so the generic
  // ImportText property applier sets them.
  const s0 = p.scale_min;
  const s1 = p.scale_max;
  const transform: PCGNode = node(
    'transform', 'PCGTransformPointsSettings', 'Scale + Yaw Jitter',
    390, 0,
    {
      // Uniform scale in [scale_min, scale_max]; X component is what
      // bUniformScale reads, but set all axes for clarity.
      ScaleMin: `(X=${s0},Y=${s0},Z=${s0})`,
      ScaleMax: `(X=${s1},Y=${s1},Z=${s1})`,
      bUniformScale: true,
      bAbsoluteScale: false,
      // Yaw jitter in [0, yaw_jitter] degrees, added to the point's rotation.
      RotationMin: '(Pitch=0,Yaw=0,Roll=0)',
      RotationMax: `(Pitch=0,Yaw=${p.yaw_jitter},Roll=0)`,
      bAbsoluteRotation: false,
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
      MeshEntries: (p.meshes && p.meshes.length > 0)
        ? p.meshes.map(m => ({ mesh: m.mesh, weight: m.weight }))
        : [{ mesh: p.mesh, weight: 1 }],
    },
  );

  return {
    version: '2',
    meta: {
      sourceGraph: p.graph_name,
      ueVersion: '5.8',
      exportedAt: new Date().toISOString(),
      tags: ['hayba.recipe', 'scatter.pcg_biome'],
    },
    nodes: [actorSource, sampler, transform, spawner],
    edges: [
      edge('actor', 'sampler'),
      edge('sampler', 'transform'),
      edge('transform', 'spawner'),
    ],
    metadata: {},
  } as PCGGraphJSON;
}

export const pcgBiomeExecutor: RecipeExecutor = async (rawParams, ctx) => {
  const p = rawParams as unknown as PcgBiomeParams;

  if (!ctx.dispatch) {
    throw new Error(
      'pcg_biome requires a UE bridge — setupRecipeSystem({ ueBridge }) was not wired',
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
