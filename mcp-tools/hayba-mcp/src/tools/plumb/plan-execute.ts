// plumb_plan_build — turn an expanded PlacementPlan into actors.
//
// The grammar has produced plans since it was written and nothing consumed
// them, so a caller got a list of what should exist and had to place all of it
// by hand. This closes that, for the parts that can honestly be closed.
//
// What it builds: `asset` and `scatter` emits, laid out on the room's own
// footprint and grounded by the same trace world_generate uses -- and `shell`,
// once it turned out a wall need not mean generated geometry. A wall is a row
// of wall meshes, and the segment length comes from the bound mesh's own
// bounds so the pieces butt rather than overlap.
//
// What it still refuses: `fill`, a curved shell profile, and anything anchored
// to a shell feature. A crack decal placed at floor height because there is no
// arch to hang it on is worse than an honest gap.

import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import { conformToGround } from '../world/terrain-conform.js';
import {
  pointsFor, wallSegments, SEGMENTABLE_PROFILES,
  type LayoutPoint, type RoomFootprint,
} from './plan-layout.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['spawns_actors'],
  when: 'you have a plan from plumb_grammar_expand and want the placeable parts actually built',
  not_when: 'you only want to see the plan — plumb_grammar_expand already returns it',
};

/** Emits with nothing to place. `shell` is handled separately: it CAN be
 *  built, as a run of wall segments, when a mesh is bound and the profile is
 *  straight-sided. */
const NOT_BUILDABLE: Record<string, string> = {
  fill: 'a fill is volumetric; there is no mesh to place',
  decal: 'a decal needs a surface on a shell that is not built',
};

/** Length of a mesh along its X axis, in metres — the run spacing for a wall.
 *  Falls back to 2m when bounds cannot be read, because a wrong-but-stated
 *  spacing beats refusing to build the room. */
async function segmentLengthM(asset: string): Promise<{ len: number; assumed: boolean }> {
  try {
    const info = await executeCommand<Record<string, unknown>>('mesh_get_info', { path: asset });
    const b = info?.bounds as { min?: Record<string, number>; max?: Record<string, number> } | undefined;
    if (b?.min && b?.max && typeof b.min.x === 'number' && typeof b.max.x === 'number') {
      const cm = Math.abs(b.max.x - b.min.x);
      if (cm > 1) return { len: cm / 100, assumed: false };
    }
  } catch { /* fall through to the stated default */ }
  return { len: 2, assumed: true };
}

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
  /** One entry per MESH, listing every role that resolved to it. Two roles
   *  bound to the same mesh share an ISM actor, and reporting only one of them
   *  reads as "the other was never placed". */
  built: Array<{ roles: string[]; asset: string; instances: number }>;
  /** Items deliberately not built, each with the reason. */
  skipped: Array<{ kind: string; role: string; reason: string }>;
  /** Roles the plan uses that the caller did not bind. */
  unbound: string[];
  grounded: boolean;
  ground_note?: string;
  /** Things worth saying that are not failures — e.g. a wall spacing that had
   *  to be assumed because the mesh bounds could not be read. */
  notes?: string[];
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
  /** asset path → every role that bound to it, in first-seen order. */
  const rolesOf = new Map<string, string[]>();

  const notes: string[] = [];

  for (const item of params.plan.items) {
    const label = item.role ?? item.tag ?? item.kind;

    const why = NOT_BUILDABLE[item.kind];
    if (why) { skipped.push({ kind: item.kind, role: label, reason: why }); continue; }

    const asset = params.bindings[label];
    if (!asset) { unbound.add(label); continue; }

    let points: LayoutPoint[];
    if (item.kind === 'shell') {
      const profile = String(item.meta.profile_curve ?? 'box');
      if (!SEGMENTABLE_PROFILES.has(profile)) {
        // An arch or a cavern is a curved section. Squaring it off with
        // straight wall pieces is not the room that was asked for.
        skipped.push({
          kind: item.kind, role: label,
          reason: `profile "${profile}" is curved; a run of straight wall segments would be a different room`,
        });
        continue;
      }
      const seg = await segmentLengthM(asset);
      if (seg.assumed) {
        notes.push(`${label}: could not read the mesh bounds, so wall segments are spaced at ${seg.len}m`);
      }
      points = wallSegments(fp, seg.len);
    } else {
      const resolved = pointsFor(item.meta, fp, {
        scatterCount: params.scatter_count ?? 8,
        seed: (params.seed ?? 1337) + item.index,
      });
      if (resolved.unresolved) {
        skipped.push({ kind: item.kind, role: label, reason: resolved.unresolved });
        continue;
      }
      points = resolved.points;
    }

    byAsset.set(asset, [...(byAsset.get(asset) ?? []), ...points]);
    const seen = rolesOf.get(asset) ?? [];
    if (!seen.includes(label)) seen.push(label);
    rolesOf.set(asset, seen);
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
        roles: rolesOf.get(asset) ?? [], asset, instances: pts.length,
      })),
      skipped, unbound: [...unbound], grounded: !conform.unavailable,
      ...(conform.unavailable ? { ground_note: conform.unavailable } : {}),
      ...(notes.length ? { notes } : {}),
      errors, dry_run: true,
    };
  }

  for (const [asset, pts] of byAsset) {
    const roles = rolesOf.get(asset) ?? ['item'];
    const role = roles.join('_');
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
      built.push({ roles, asset, instances: placed });
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
    ...(notes.length ? { notes } : {}),
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
