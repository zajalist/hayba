// plumb_plan_build — turn an expanded PlacementPlan into actors.
//
// The grammar has produced plans since it was written and nothing consumed
// them, so a caller got a list of what should exist and had to place all of it
// by hand. This closes that, for the parts that can honestly be closed.
//
// What it builds: `asset` and `scatter` emits, laid out on the room's own
// footprint and grounded by the same trace world_generate uses.
//
// What it refuses: `shell`, `fill`, and anything anchored to a shell feature.
// Building a wall means generating geometry, and a crack decal placed at floor
// height because there is no arch to hang it on is worse than an honest gap.

import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import { conformToGround } from '../world/terrain-conform.js';
import { pointsFor, type LayoutPoint, type RoomFootprint } from './plan-layout.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['spawns_actors'],
  when: 'you have a plan from plumb_grammar_expand and want the placeable parts actually built',
  not_when: 'you only want to see the plan — plumb_grammar_expand already returns it',
};

/** Emits that describe geometry rather than placed props. */
const NOT_BUILDABLE: Record<string, string> = {
  shell: 'a shell is generated geometry (walls, arches); there is no mesh to place',
  fill: 'a fill is volumetric; there is no mesh to place',
  decal: 'a decal needs a surface on a shell that is not built',
};

export const schema = z.object({
  plan: z.object({
    items: z.array(z.object({
      kind: z.string(),
      role: z.string().optional(),
      tag: z.string().optional(),
      symbolKind: z.string(),
      index: z.number(),
      meta: z.record(z.string(), z.unknown()),
    })),
  }).describe('A plan from plumb_grammar_expand'),
  bindings: z.record(z.string(), z.string())
    .describe('role or tag → StaticMesh path. Anything unbound is reported, never guessed at.'),
  room: z.object({
    w: z.number().positive().describe('Room width in metres'),
    h: z.number().positive().describe('Room depth in metres'),
    center_cm: z.tuple([z.number(), z.number(), z.number()]).describe('Room centre in cm'),
  }),
  seed: z.number().int().optional().describe('Deterministic seed for scatter (default 1337)'),
  scatter_count: z.number().int().positive().optional().describe('Instances per scatter emit (default 8)'),
  dry_run: z.boolean().optional().describe('Resolve and lay out, but spawn nothing'),
});

export type PlanBuildParams = z.infer<typeof schema>;

export interface PlanBuildResult {
  ok: boolean;
  built: Array<{ role: string; asset: string; instances: number }>;
  /** Items deliberately not built, each with the reason. */
  skipped: Array<{ kind: string; role: string; reason: string }>;
  /** Roles the plan uses that the caller did not bind. */
  unbound: string[];
  grounded: boolean;
  ground_note?: string;
  errors: string[];
  dry_run?: true;
}

export async function planBuild(params: PlanBuildParams): Promise<PlanBuildResult> {
  const fp: RoomFootprint = params.room;
  const built: PlanBuildResult['built'] = [];
  const skipped: PlanBuildResult['skipped'] = [];
  const unbound = new Set<string>();
  const errors: string[] = [];

  /** asset path → the points to place it at. */
  const byAsset = new Map<string, LayoutPoint[]>();
  const roleOf = new Map<string, string>();

  for (const item of params.plan.items) {
    const label = item.role ?? item.tag ?? item.kind;

    const why = NOT_BUILDABLE[item.kind];
    if (why) { skipped.push({ kind: item.kind, role: label, reason: why }); continue; }

    const asset = params.bindings[label];
    if (!asset) { unbound.add(label); continue; }

    const resolved = pointsFor(item.meta, fp, {
      scatterCount: params.scatter_count ?? 8,
      seed: (params.seed ?? 1337) + item.index,
    });
    if (resolved.unresolved) {
      skipped.push({ kind: item.kind, role: label, reason: resolved.unresolved });
      continue;
    }

    byAsset.set(asset, [...(byAsset.get(asset) ?? []), ...resolved.points]);
    roleOf.set(asset, label);
  }

  // Ground every point in one trace, the same way world_generate does. A room
  // laid out on a flat plane and dropped onto sloped ground is a room with its
  // columns buried at one end.
  const all = [...byAsset.values()].flat();
  const conform = await conformToGround(
    all.map((p) => [p.loc_cm[0], p.loc_cm[1]] as const),
    fp.center_cm[2],
  );
  if (!conform.unavailable) {
    let i = 0;
    for (const pts of byAsset.values()) {
      for (const p of pts) {
        const z = conform.hits[i++]?.z;
        if (typeof z === 'number') p.loc_cm = [p.loc_cm[0], p.loc_cm[1], z];
      }
    }
  }

  if (params.dry_run) {
    return {
      ok: true, built: [...byAsset.entries()].map(([asset, pts]) => ({
        role: roleOf.get(asset) ?? '?', asset, instances: pts.length,
      })),
      skipped, unbound: [...unbound], grounded: !conform.unavailable,
      ...(conform.unavailable ? { ground_note: conform.unavailable } : {}),
      errors, dry_run: true,
    };
  }

  for (const [asset, pts] of byAsset) {
    const role = roleOf.get(asset) ?? 'item';
    try {
      const created = await executeCommand<Record<string, unknown>>('ism_create_actor', {
        static_mesh_path: asset,
        label: `PLAN_${role}`,
        location: fp.center_cm,
      });
      const actorId = (created?.actor_id ?? created?.id) as string | undefined;
      if (!actorId) { errors.push(`${role}: ism_create_actor returned no actor_id`); continue; }

      let placed = 0;
      const transforms = pts.map((p) => ({
        location: p.loc_cm, rotation: [0, p.yaw_deg, 0], scale: [1, 1, 1],
      }));
      for (let i = 0; i < transforms.length; i += 1000) { // ism_add_instances caps at 1000
        const chunk = transforms.slice(i, i + 1000);
        const added = await executeCommand<Record<string, unknown>>('ism_add_instances', {
          actor_id: actorId, transforms: chunk,
        });
        placed += (added?.added as number | undefined) ?? chunk.length;
      }
      built.push({ role, asset, instances: placed });
    } catch (e) {
      errors.push(`${role}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    ok: errors.length === 0,
    built,
    skipped,
    unbound: [...unbound],
    grounded: !conform.unavailable,
    ...(conform.unavailable ? { ground_note: conform.unavailable } : {}),
    errors,
  };
}

export const planBuildHandler: ToolHandler = async (args) => {
  const params = schema.parse(args);
  const result = await planBuild(params);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    isError: !result.ok,
  };
};
