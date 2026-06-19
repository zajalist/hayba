// MCP tool handlers for the PLUMB constraint subsystem.
//
// Surface (all `plumb_`-prefixed so the catalog groups them):
//   plumb_primitives        → the closed grammar (discovery)
//   plumb_profile_bake      → deterministic geometry/physics bake from UE bounds
//   plumb_profile_annotate  → layer AI qualitative semantics (front/affordances) + lock
//   plumb_profile_list/get  → browse the profile store (Memory-tab feed)
//   plumb_constraint_define → author/upsert a bound constraint (validated)
//   plumb_constraint_list   → list the library
//   plumb_constraint_remove → delete by id
//   plumb_constraint_propose→ AI-draft constraints from a profile (primitives only)
//   plumb_validate          → run library constraints over instances → Verdict
//
// Handlers are pure over the stores in src/plumb; no UE round-trip lives here
// except where the agent passes bounds in. The bake's UE-side auto-fetch of
// bounds is a follow-up (the agent supplies origin/extent for now).

import { z } from 'zod';
import {
  PRIMITIVES, primitivesById,
  bakeProfile, putProfile, getProfile, loadProfiles, annotateProfile, profileMap,
  upsertConstraint, loadConstraints, removeConstraint, constraintsFor,
  evaluate,
  type Constraint, type InstanceState, type Transform,
} from '../../plumb/index.js';

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);

// ── plumb_primitives ─────────────────────────────────────────────────────────

export const plumbPrimitivesSchema = {};
export async function plumbPrimitivesHandler(): Promise<{ primitives: unknown[]; note: string }> {
  return {
    primitives: PRIMITIVES.map(p => ({
      id: p.id, gate: p.gate, default_hard: p.defaultHard, qualitative: p.qualitative,
      params: p.params, doc: p.doc,
    })),
    note: 'This is the COMPLETE constraint grammar (closed set). Author constraints by picking a primitive and filling params + a binding — no custom logic is possible by design.',
  };
}

// ── plumb_profile_bake ───────────────────────────────────────────────────────

export const plumbProfileBakeSchema = {
  asset: z.string().describe('Asset path, e.g. /Game/Meshes/SM_GiantTree_01'),
  origin_cm: vec3.describe('AABB centre in cm (UE world units)'),
  extent_cm: vec3.describe('AABB half-extent in cm'),
  pivot_to_base_cm: z.number().optional().describe('Pivot→base offset in cm (negative when pivot is above the visible base, e.g. SM_GiantTree_01 ≈ -380). Defaults to -extent.z.'),
  mass_kg: z.number().optional(),
  com_cm: vec3.optional().describe('Local centre of mass in cm'),
  footprint_cm: z.array(z.tuple([z.number(), z.number()])).optional().describe('Convex base footprint, local XY in cm; defaults to the AABB box'),
  profile_archetype: z.string().optional().describe('Archetype tag, default "rigid_prop"'),
};
export async function plumbProfileBakeHandler(args: {
  asset: string; origin_cm: [number, number, number]; extent_cm: [number, number, number];
  pivot_to_base_cm?: number; mass_kg?: number; com_cm?: [number, number, number];
  footprint_cm?: [number, number][]; profile_archetype?: string;
}, nowIso: string): Promise<{ ok: boolean; profile: unknown }> {
  const profile = bakeProfile({
    asset_id: args.asset, origin_cm: args.origin_cm, extent_cm: args.extent_cm,
    pivot_to_base_cm: args.pivot_to_base_cm, mass_kg: args.mass_kg,
    com_cm: args.com_cm, footprint_cm: args.footprint_cm,
  }, nowIso, args.profile_archetype);
  putProfile(profile);
  return { ok: true, profile };
}

// ── plumb_profile_annotate ───────────────────────────────────────────────────

const affordanceSchema = z.object({
  id: z.string(),
  region: z.object({ center: vec3, extents: vec3 }).optional(),
  detail: z.string().optional(),
});

export const plumbProfileAnnotateSchema = {
  asset: z.string(),
  cls: z.string().optional().describe('Semantic class, e.g. "tree", "door"'),
  up: vec3.optional().describe('Local up vector'),
  front: vec3.optional().describe('Local front vector (drives the `facing` primitive)'),
  affordances: z.array(affordanceSchema).optional().describe('Named local-space regions, e.g. door swing / seat'),
  lock: z.array(z.string()).optional().describe('Field paths to lock so qualitative constraints may hard-gate, e.g. ["semantics.front", "affordance:swing"]'),
};
export async function plumbProfileAnnotateHandler(args: {
  asset: string; cls?: string; up?: [number, number, number]; front?: [number, number, number];
  affordances?: Array<{ id: string; region?: { center: [number, number, number]; extents: [number, number, number] }; detail?: string }>;
  lock?: string[];
}): Promise<{ ok: boolean; profile?: unknown; error?: string }> {
  const patch: Record<string, unknown> = {};
  if (args.cls !== undefined) patch.cls = args.cls;
  if (args.up !== undefined) patch.up = args.up;
  if (args.front !== undefined) patch.front = args.front;
  if (args.affordances !== undefined) patch.affordances = args.affordances;
  const merged = annotateProfile(args.asset, patch as never, { lock: args.lock });
  if (!merged) return { ok: false, error: `no baked profile for "${args.asset}" — run plumb_profile_bake first` };
  return { ok: true, profile: merged };
}

// ── plumb_profile_list / get ─────────────────────────────────────────────────

export const plumbProfileListSchema = {};
export async function plumbProfileListHandler(): Promise<{ profiles: Array<{ asset_id: string; profile: string; affordances: number; locked: string[] }> }> {
  return {
    profiles: loadProfiles().map(p => ({
      asset_id: p.asset_id, profile: p.profile,
      affordances: p.semantics.affordances.length, locked: p.provenance.locked,
    })),
  };
}

export const plumbProfileGetSchema = { asset: z.string() };
export async function plumbProfileGetHandler(args: { asset: string }): Promise<{ ok: boolean; profile?: unknown; error?: string }> {
  const p = getProfile(args.asset);
  return p ? { ok: true, profile: p } : { ok: false, error: `no profile for "${args.asset}"` };
}

// ── plumb_constraint_define / list / remove ──────────────────────────────────

const bindingSchema = z.object({
  asset: z.string().optional(),
  tag: z.object({ axis: z.string(), value: z.string() }).optional(),
});

export const plumbConstraintDefineSchema = {
  id: z.string(),
  primitive: z.string().describe('One of the closed primitive ids (see plumb_primitives)'),
  params: z.record(z.unknown()).optional(),
  binding: bindingSchema.describe('Exactly one of {asset, tag}'),
  hard: z.boolean().optional().describe('Override the primitive default hard/soft'),
  note: z.string().optional(),
  refs: z.array(z.string()).optional(),
};
export async function plumbConstraintDefineHandler(args: {
  id: string; primitive: string; params?: Record<string, unknown>;
  binding: { asset?: string; tag?: { axis: string; value: string } };
  hard?: boolean; note?: string; refs?: string[];
}): Promise<{ ok: boolean; errors?: unknown[] }> {
  const c: Constraint = {
    id: args.id, primitive: args.primitive, params: args.params ?? {},
    binding: args.binding, hard: args.hard, note: args.note, refs: args.refs,
  };
  const r = upsertConstraint(c);
  return r.ok ? { ok: true } : { ok: false, errors: r.errors };
}

export const plumbConstraintListSchema = {
  asset: z.string().optional().describe('Filter to constraints bound to this asset/tag context'),
};
export async function plumbConstraintListHandler(args: { asset?: string }): Promise<{ constraints: Constraint[] }> {
  const all = loadConstraints();
  if (!args.asset) return { constraints: all };
  return { constraints: all.filter(c => c.binding.asset === args.asset) };
}

export const plumbConstraintRemoveSchema = { id: z.string() };
export async function plumbConstraintRemoveHandler(args: { id: string }): Promise<{ ok: boolean; removed: boolean }> {
  return { ok: true, removed: removeConstraint(args.id) };
}

// ── plumb_constraint_propose ─────────────────────────────────────────────────
//
// Drafts (does NOT save) constraints from a baked profile, using only the closed
// primitive set. The agent reviews + edits, then calls plumb_constraint_define.

export const plumbConstraintProposeSchema = { asset: z.string() };
export async function plumbConstraintProposeHandler(args: { asset: string }): Promise<{ ok: boolean; proposals?: Partial<Constraint>[]; error?: string }> {
  const p = getProfile(args.asset);
  if (!p) return { ok: false, error: `no profile for "${args.asset}" — bake first` };
  const proposals: Partial<Constraint>[] = [];
  const base = args.asset.split('/').pop() ?? 'asset';

  // grounded — always proposable; encodes the pivot offset lesson.
  proposals.push({
    id: `${base}_grounded`, primitive: 'grounded',
    params: { tolerance_m: 0.05 }, binding: { asset: args.asset },
    note: `Seat ${base} on the ground (ground_offset ${p.structural.ground_offset_m?.toFixed(2)}m).`,
  });
  // support_margin — only when a real footprint was baked.
  if (p.structural.support_footprint && p.structural.support_footprint.length >= 3) {
    proposals.push({
      id: `${base}_support`, primitive: 'support_margin',
      params: { min_m: 0.02 }, binding: { asset: args.asset },
      note: 'CoM must stay over the support footprint.',
    });
  }
  // facing — only when front was annotated (locked or not).
  if (p.semantics.front && (p.semantics.front[0] !== 1 || p.semantics.front[1] !== 0)) {
    proposals.push({
      id: `${base}_facing`, primitive: 'facing',
      params: { max_deg: 30 }, binding: { asset: args.asset },
      note: 'Qualitative — soft until semantics.front is locked.',
    });
  }
  // affordance_clear — one per baked affordance.
  for (const aff of p.semantics.affordances) {
    proposals.push({
      id: `${base}_aff_${aff.id}`, primitive: 'affordance_clear',
      params: { affordance: aff.id }, binding: { asset: args.asset },
      note: `Keep the "${aff.id}" affordance unoccluded.`,
    });
  }
  return { ok: true, proposals };
}

// ── plumb_validate ───────────────────────────────────────────────────────────

const transformSchema = z.object({
  pos: vec3,
  quat: vec4.optional(),
  scale: vec3.optional(),
});
const instanceSchema = z.object({
  object: z.string(),
  asset: z.string().optional(),
  tags: z.record(z.string()).optional(),
  transform: transformSchema,
});

export const plumbValidateSchema = {
  instances: z.array(instanceSchema).describe('Instances to validate (object id + optional asset/tags + transform)'),
  constraint_ids: z.array(z.string()).optional().describe('Restrict to these library constraint ids; default = all enabled'),
};
export async function plumbValidateHandler(args: {
  instances: Array<{ object: string; asset?: string; tags?: Record<string, string>; transform: { pos: [number, number, number]; quat?: [number, number, number, number]; scale?: [number, number, number] } }>;
  constraint_ids?: string[];
}): Promise<{ verdict: unknown }> {
  const instances: InstanceState[] = args.instances.map(i => ({
    object: i.object, asset: i.asset, tags: i.tags,
    transform: {
      pos: i.transform.pos,
      quat: i.transform.quat ?? [0, 0, 0, 1],
      scale: i.transform.scale ?? [1, 1, 1],
    } as Transform,
  }));
  let constraints = loadConstraints();
  if (args.constraint_ids?.length) {
    const set = new Set(args.constraint_ids);
    constraints = constraints.filter(c => set.has(c.id));
  }
  const verdict = evaluate(instances, constraints, { profiles: profileMap() });
  return { verdict };
}

void constraintsFor; void primitivesById; // re-exported helpers, kept for tool growth
