// mcp-tools/hayba-mcp/src/tools/pcg/pcg-scatter-mesh.ts
//
// One-call scatter convenience. Collapses the 4-step manual flow we validated
// by hand — build graph → create asset → spawn a PCGVolume bound to it →
// generate → read back instance counts — into a single tool call.
//
// The graph itself (including the scale/yaw jitter transform node) is produced
// by buildBiomeScatterGraph, so this tool and the scatter.pcg_biome recipe share
// one source of graph truth.
//
// Like pcg_cook_and_wait, this HARD-FAILS (ok:false) on a zero-instance cook:
// a graph that generates cleanly but places nothing is almost always broken
// (mesh never bound, or the surface source produced no points), and silent
// success on empty output is the single most common scatter trap.

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import { runUePythonJson, pyStr } from '../ue-python.js';
import { buildBiomeScatterGraph } from '../../recipes/scatter/pcg_biome.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['mutates_scene', 'gpu_load', 'wait'],
  when: 'to scatter a mesh (or weighted mesh set) across a surface in ONE call — builds the jittered PCG graph, spawns a bound PCGVolume, generates, and returns the instance count. Fails loud on 0 instances.',
  not_when: 'you already have a placed PCGVolume and only want to regenerate/read it back — use pcg_cook_and_wait',
};

const meshEntrySchema = z.object({
  mesh: z.string().min(1).describe('StaticMesh asset path, e.g. /Game/Foliage/SM_Pine'),
  weight: z.number().positive().default(1).describe('Relative selection weight'),
});

export const schema = z.object({
  area_or_landscape: z.string().min(1)
    .describe('Label or path of the surface source actor (Landscape/LandscapeProxy) the scatter samples'),
  mesh: z.string().optional()
    .describe('Single StaticMesh path. Provide this OR `meshes`, not both.'),
  meshes: z.array(meshEntrySchema).optional()
    .describe('Weighted mesh list; overrides `mesh` when supplied.'),
  density: z.number().positive().default(0.5)
    .describe('Points per squared meter for the surface sampler'),
  scale_min: z.number().positive().default(0.9).describe('Min uniform scale factor'),
  scale_max: z.number().positive().default(1.2).describe('Max uniform scale factor'),
  yaw_jitter: z.number().min(0).max(360).default(360).describe('Max random yaw in degrees, added per point'),
  seed: z.number().int().default(1337).describe('Deterministic seed for sampler + transform jitter'),
  volume_scale: z.number().positive().default(100)
    .describe('Uniform scale applied to the spawned PCGVolume (its cube bounds define the generation domain)'),
  graph_name: z.string().default('HaybaScatter').describe('Base name for the generated PCGGraph asset'),
  timeout_s: z.number().int().min(1).max(600).default(120)
    .describe('Hard timeout waiting for the PCG graph to settle'),
});
export type PcgScatterMeshParams = z.input<typeof schema>;

/** Time-stamped asset name so successive runs never collide. */
function uniqueGraphName(base: string, seed: number): string {
  return `${base}_${seed}_${Date.now().toString(36)}`;
}

/** Python: spawn a PCGVolume, bind the graph to its PCGComponent, generate. */
function spawnAndGenerateScript(assetPath: string, volumeScale: number, label: string): string {
  return [
    `_asset = ${pyStr(assetPath)}`,
    `_scale = ${volumeScale}`,
    `_label = ${pyStr(label)}`,
    'try:',
    '    graph = unreal.load_asset(_asset)',
    '    if graph is None: raise Exception("graph asset not found: %s" % _asset)',
    '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    '    vol = eas.spawn_actor_from_class(unreal.PCGVolume, unreal.Vector(0,0,0), unreal.Rotator(0,0,0))',
    '    if vol is None: raise Exception("failed to spawn PCGVolume")',
    '    vol.set_actor_label(_label)',
    '    vol.set_actor_scale3d(unreal.Vector(_scale, _scale, _scale))',
    '    comps = list(vol.get_components_by_class(unreal.PCGComponent))',
    '    if not comps: raise Exception("spawned PCGVolume has no PCGComponent")',
    '    comp = comps[0]',
    '    bound = False',
    '    for setter in ("set_graph", "set_graph_interface"):',
    '        fn = getattr(comp, setter, None)',
    '        if fn is None: continue',
    '        try:',
    '            fn(graph); bound = True; break',
    '        except Exception: pass',
    '    if not bound:',
    '        try:',
    '            comp.set_editor_property("graph", graph); bound = True',
    '        except Exception: pass',
    '    if not bound: raise Exception("could not bind graph to PCGComponent")',
    '    done = False',
    '    for attempt in ("generate", "generate_local", "regenerate_in_editor"):',
    '        fn = getattr(comp, attempt, None)',
    '        if fn is None: continue',
    '        try:',
    '            fn(True) if attempt != "regenerate_in_editor" else fn()',
    '            done = True; break',
    '        except Exception: pass',
    '    if not done: raise Exception("generate failed on PCGComponent")',
    '    _emit({"ok": True, "volume_actor": vol.get_path_name(), "label": vol.get_actor_label()})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

/** Python: count ISM/HISM instances on the spawned volume. */
function inspectScript(volumePath: string): string {
  return [
    `_vol_path = ${pyStr(volumePath)}`,
    'try:',
    '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    '    target = None',
    '    for a in eas.get_all_level_actors():',
    '        try:',
    '            if a.get_path_name() == _vol_path: target = a; break',
    '        except Exception: pass',
    '    if target is None: raise Exception("volume actor not found: %s" % _vol_path)',
    '    out = []',
    '    for comp in target.get_components_by_class(unreal.InstancedStaticMeshComponent):',
    '        mesh = comp.static_mesh',
    '        out.append({"mesh": (mesh.get_path_name() if mesh else None), "count": comp.get_instance_count()})',
    '    _emit({"ok": True, "ism": out, "total": sum(x["count"] for x in out)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export async function pcgScatterMeshHandler(params: PcgScatterMeshParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const p = parsed.data;
  if (!p.mesh && !(p.meshes && p.meshes.length > 0)) {
    return { content: [{ type: 'text' as const, text: 'pcg_scatter_mesh: provide `mesh` or a non-empty `meshes` list' }], isError: true };
  }

  const graphName = uniqueGraphName(p.graph_name, p.seed);
  const graph = buildBiomeScatterGraph({
    area_actor: p.area_or_landscape,
    mesh: p.mesh ?? '',
    meshes: p.meshes,
    density: p.density,
    scale_min: p.scale_min,
    scale_max: p.scale_max,
    yaw_jitter: p.yaw_jitter,
    seed: p.seed,
    graph_name: graphName,
  });

  const fail = (error: string, extra: Record<string, unknown> = {}) => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error, ...extra }, null, 2) }],
    isError: true,
  });

  try {
    // 1. Create the PCGGraph asset.
    const created = await executeCommand<{ created?: boolean; assetPath?: string; errors?: unknown[] }>(
      'create_graph', { graph, name: graphName },
    );
    if (created?.created === false) {
      return fail('pcg_scatter_mesh: graph validation failed', { errors: created.errors });
    }
    const graphAsset = created?.assetPath ?? `/Game/Hayba/Generated/${graphName}`;

    // 2. Spawn a PCGVolume bound to the graph and generate it.
    const spawn = await runUePythonJson<{ ok?: boolean; volume_actor?: string; label?: string; error?: string }>(
      spawnAndGenerateScript(graphAsset, p.volume_scale, graphName), 60_000,
    );
    if (!spawn?.ok || !spawn.volume_actor) {
      return fail(`pcg_scatter_mesh: spawn/generate failed — ${spawn?.error ?? 'unknown'}`, { graph_asset: graphAsset });
    }

    // 3. Block on the PCG subsystem settling for THIS volume (generate is async).
    const idle = await executeCommand('wait_for_idle', {
      subsystems: ['pcg'],
      pcg_actors: [spawn.volume_actor],
      timeout_s: p.timeout_s,
    }, { timeout: p.timeout_s * 1000 + 5000 });

    // 4. Read back the instance count.
    const counts = await runUePythonJson<{ ok?: boolean; total?: number; ism?: unknown[]; error?: string }>(
      inspectScript(spawn.volume_actor), 30_000,
    );
    const instances = typeof counts?.total === 'number' ? counts.total : 0;

    // 5. Hard-fail on a zero-instance cook (see pcg_cook_and_wait rationale).
    if (instances === 0) {
      return fail(
        'PCG generated 0 instances — check mesh binding (StaticMeshSpawner MeshEntries) / surface source. The graph cooked cleanly but produced no instances.',
        { graph_asset: graphAsset, volume_actor: spawn.volume_actor, idle, result: counts },
      );
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          graph_asset: graphAsset,
          volume_actor: spawn.volume_actor,
          instances,
          result: counts,
          idle,
        }, null, 2),
      }],
    };
  } catch (e) {
    return fail(`pcg_scatter_mesh error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
