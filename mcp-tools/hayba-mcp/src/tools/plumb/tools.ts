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
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PRIMITIVES, primitivesById,
  bakeProfile, putProfile, getProfile, loadProfiles, annotateProfile, profileMap,
  upsertConstraint, loadConstraints, removeConstraint, constraintsFor,
  evaluate, evaluatePerInstance, addMask, removeMask,
  loadLessons, getLesson, upsertLesson, removeLesson,
  takeStudyRequests,
  putProduction, listProductions, removeProduction, validateProduction,
  expandGrammar,
  type Constraint, type InstanceState, type Transform, type Mask, type Verdict,
  type Production,
} from '../../plumb/index.js';
import { addSocket as addSocketToProfile } from '../../plumb/profile-store.js';
import { makeGuardFn } from '../../plumb/grammar-guards.js';
import type { Socket } from '../../plumb/contracts.js';
import { replaceFindingsWithPrefix, type ValidatorFinding } from '../../validator/index.js';
import { segmentProject } from '../visual/sidecar-client.js';

/** Convert a PLUMB Verdict's failing constraints into unified validator
 *  findings — so PLUMB violations show in the one Validation tab alongside the
 *  legacy rule findings. */
function verdictToFindings(verdict: Verdict, constraints: Constraint[], nowIso: string): ValidatorFinding[] {
  const byId = new Map(constraints.map(c => [c.id, c]));
  const out: ValidatorFinding[] = [];
  for (const gate of verdict.gates) {
    for (const r of gate.constraints) {
      if (r.ok) continue;
      const [cid, object = ''] = r.name.split('@');
      const c = byId.get(cid);
      const fix = r.fix ? `move by [${r.fix.translate.map(n => n.toFixed(2)).join(', ')}] m` : `value_m ${r.value_m.toFixed(2)}`;
      out.push({
        ruleId: `plumb:${r.name}`,
        severity: r.hard ? 'error' : 'warning',
        message: `[${gate.gate}] ${r.primitive} failed${object ? ` on ${object}` : ''}${r.detail ? ` — ${r.detail}` : ''}`,
        hint: `Suggested fix: ${fix}.${r.locked === false && r.confidence !== undefined ? ' (qualitative — lock the field to hard-gate)' : ''}`,
        refs: c?.refs,
        context: { value_m: r.value_m, fix: r.fix?.translate, gate: gate.gate, object, primitive: r.primitive, hard: r.hard },
        timestamp: nowIso,
        toolName: 'plumb_validate',
      });
    }
  }
  return out;
}

function verdictsPath(): string {
  return process.env.HAYBA_VERDICTS
    ?? join(dirname(process.env.HAYBA_PROFILES ?? join(process.cwd(), '.scratch', 'x')), 'verdicts.json');
}

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
  origin_cm: vec3.optional().describe('AABB centre in cm (UE units). Omit to auto-fetch via mesh_get_info.'),
  extent_cm: vec3.optional().describe('AABB half-extent in cm. Omit to auto-fetch via mesh_get_info.'),
  pivot_to_base_cm: z.number().optional().describe('Pivot→base offset in cm (negative when the pivot is above the visible base, e.g. SM_GiantTree_01 ≈ -380). Auto-derived from bounds.min.z when omitted.'),
  mass_kg: z.number().optional(),
  com_cm: vec3.optional().describe('Local centre of mass in cm'),
  footprint_cm: z.array(z.tuple([z.number(), z.number()])).optional().describe('Convex base footprint, local XY in cm; defaults to the AABB box'),
  profile_archetype: z.string().optional().describe('Archetype tag, default "rigid_prop"'),
};

/** Fetches a StaticMesh's local bounds (cm) for auto-bake. Injected so the
 *  handler stays unit-testable without UE. */
export type MeshBoundsFetcher = (asset: string) => Promise<{
  min: [number, number, number]; max: [number, number, number]; extents: [number, number, number];
}>;

export async function plumbProfileBakeHandler(args: {
  asset: string; origin_cm?: [number, number, number]; extent_cm?: [number, number, number];
  pivot_to_base_cm?: number; mass_kg?: number; com_cm?: [number, number, number];
  footprint_cm?: [number, number][]; profile_archetype?: string;
}, nowIso: string, fetchBounds?: MeshBoundsFetcher): Promise<{ ok: boolean; profile?: unknown; error?: string }> {
  let origin = args.origin_cm;
  let extent = args.extent_cm;
  let pivotToBase = args.pivot_to_base_cm;

  if (!origin || !extent) {
    if (!fetchBounds) return { ok: false, error: 'origin_cm/extent_cm omitted and no UE connection to auto-fetch bounds — pass them explicitly or connect the editor' };
    try {
      const b = await fetchBounds(args.asset);
      origin = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      extent = b.extents;
      // Pivot is the mesh local origin (0,0,0); the base contact surface is the
      // box bottom, so its z relative to the pivot is bounds.min.z.
      if (pivotToBase === undefined) pivotToBase = b.min[2];
    } catch (e) {
      return { ok: false, error: `mesh_get_info bounds fetch failed for "${args.asset}": ${(e as Error).message}` };
    }
  }

  const profile = bakeProfile({
    asset_id: args.asset, origin_cm: origin, extent_cm: extent,
    pivot_to_base_cm: pivotToBase, mass_kg: args.mass_kg,
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
  write_overlay: z.boolean().optional().describe('Also write per-instance results to .scratch/verdicts.json for the plan-mode viewport overlay'),
  record_findings: z.boolean().optional().describe('Record constraint failures as validator findings in the unified Validation surface (default true)'),
};
export async function plumbValidateHandler(args: {
  instances: Array<{ object: string; asset?: string; tags?: Record<string, string>; transform: { pos: [number, number, number]; quat?: [number, number, number, number]; scale?: [number, number, number] } }>;
  constraint_ids?: string[];
  write_overlay?: boolean;
  record_findings?: boolean;
}): Promise<{ verdict: unknown; per_instance?: unknown; overlay_written?: string }> {
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
  const profiles = profileMap();
  const verdict = evaluate(instances, constraints, { profiles });

  // One validator: PLUMB constraint failures become findings in the same store
  // the Validation tab reads (alongside the advisory "floppy" rule findings).
  if (args.record_findings !== false) {
    const findings = verdictToFindings(verdict, constraints, new Date().toISOString());
    await replaceFindingsWithPrefix('plumb:', findings);
  }

  if (args.write_overlay) {
    const per = evaluatePerInstance(instances, constraints, { profiles });
    const path = verdictsPath();
    const obj: Record<string, unknown> = {};
    for (const v of per) obj[v.object] = { ok: v.ok, stopped_at: v.stopped_at, fix: v.fix, soft_cost: v.soft_cost };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(obj, null, 2), 'utf-8');
    return { verdict, per_instance: per, overlay_written: path };
  }
  return { verdict };
}

// ── plumb_study ──────────────────────────────────────────────────────────────
// AI-orchestration entry point: hands the agent the asset's profile (if baked) +
// the closed grammar so it can propose masks (plumb_mask_add) + a constraint
// graph. The "Study with AI" button signals this.

export const plumbStudySchema = { asset: z.string() };
export async function plumbStudyHandler(args: { asset: string }): Promise<{
  asset: string; has_profile: boolean; profile?: unknown;
  primitives: unknown[]; mask_kinds: string[]; guidance: string;
}> {
  const p = getProfile(args.asset);
  return {
    asset: args.asset,
    has_profile: !!p,
    profile: p ?? undefined,
    primitives: PRIMITIVES.map(pr => ({ id: pr.id, gate: pr.gate, qualitative: pr.qualitative, params: pr.params, doc: pr.doc })),
    mask_kinds: ['surface', 'volume'],
    guidance: 'Study this asset: 1) ensure a baked profile (plumb_profile_bake). 2) add masks for its affordances/contact regions with plumb_mask_add (surface = triangle set, volume = shape). 3) propose constraints from the closed primitives bound to the asset, then plumb_constraint_define. Qualitative primitives (facing, affordance_clear) stay soft until the backing field is locked.',
  };
}

// ── plumb_mask_add / plumb_mask_remove ───────────────────────────────────────

const maskShapeSchema = z.object({
  kind: z.enum(['box', 'sphere', 'capsule', 'convex']),
  transform: z.object({ pos: vec3, quat: vec4, scale: vec3 }),
  extents: vec3.optional(),
  radius: z.number().optional(),
  points: z.array(vec3).optional(),
});

export const plumbMaskAddSchema = {
  asset: z.string(),
  id: z.string(),
  type: z.enum(['surface', 'volume']),
  color: z.string().optional(),
  source: z.enum(['ai', 'human']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  locked: z.boolean().optional(),
  triangles: z.array(z.number().int()).optional(),
  shape: maskShapeSchema.optional(),
  detail: z.string().optional(),
};
export async function plumbMaskAddHandler(args: {
  asset: string; id: string; type: 'surface' | 'volume'; color?: string;
  source?: 'ai' | 'human'; confidence?: number; locked?: boolean;
  triangles?: number[]; shape?: Mask['shape']; detail?: string;
}): Promise<{ ok: boolean; profile?: unknown; error?: string }> {
  const mask: Mask = {
    id: args.id, type: args.type, color: args.color ?? '#4488ff',
    source: args.source ?? 'human', confidence: args.confidence ?? (args.source === 'ai' ? 0.7 : 1),
    locked: args.locked ?? false, triangles: args.triangles, shape: args.shape, detail: args.detail,
  };
  const merged = addMask(args.asset, mask);
  if (!merged) return { ok: false, error: `no baked profile for "${args.asset}" — run plumb_profile_bake first` };
  return { ok: true, profile: merged };
}

export const plumbMaskRemoveSchema = { asset: z.string(), mask_id: z.string() };
export async function plumbMaskRemoveHandler(args: { asset: string; mask_id: string }): Promise<{ ok: boolean; removed: boolean }> {
  return { ok: true, removed: removeMask(args.asset, args.mask_id) };
}
// ── plumb_segment — agent-grounded SAM segmentation → projected masks ────────
// The agent reads the study_render color passes, names parts + a box/points per
// view, and calls this. The sidecar SAM-masks each box, back-projects to triangles
// via the world-position pass, and bakes a UV display texture; each result is
// written into the profile as an AI surface mask (with its `texture`).

export const plumbSegmentSchema = {
  asset: z.string().describe('Asset whose profile receives the masks (must be baked).'),
  study_dir: z.string().describe('study_render output dir (.scratch/study/<assetSafe>/).'),
  parts: z.array(z.object({
    label: z.string(),
    color: z.string().optional(),
    views: z.array(z.object({
      view: z.number().int(),
      box: z.array(z.number()).length(4).optional().describe('[x0,y0,x1,y1] in the color image.'),
      points: z.array(z.array(z.number())).optional().describe('[[x,y,label],...] foreground/background points.'),
    })).min(1),
  })).min(1).describe('Themed parts the agent proposes, each with a box/points per view it sees them in.'),
  vote_threshold: z.number().int().optional().describe('Min per-triangle multi-view votes to keep (default 1).'),
};
export async function plumbSegmentHandler(args: {
  asset: string; study_dir: string;
  parts: Array<{ label: string; color?: string; views: Array<{ view: number; box?: number[]; points?: number[][] }> }>;
  vote_threshold?: number;
}): Promise<{ ok: boolean; added: string[]; skipped?: string[]; error?: string }> {
  let resp;
  try {
    resp = await segmentProject({ study_dir: args.study_dir, parts: args.parts, vote_threshold: args.vote_threshold });
  } catch (e) {
    return { ok: false, added: [], error: `visual sidecar unreachable (start mcp-tools/visual-sidecar): ${(e as Error).message}` };
  }
  if (!resp.ok) return { ok: false, added: [], error: resp.error ?? 'segment_project failed' };
  const added: string[] = [];
  for (const m of resp.masks ?? []) {
    if (!m.triangles?.length && !m.texture) continue;   // nothing usable for this part
    const mask: Mask = {
      id: m.label, type: 'surface', color: m.color ?? '#48A0FF',
      source: 'ai', confidence: typeof m.coverage === 'number' ? m.coverage : 0.7,
      locked: false, triangles: m.triangles, texture: m.texture ?? undefined,
    };
    if (addMask(args.asset, mask)) added.push(m.label);
  }
  if (!added.length) {
    return { ok: false, added, skipped: resp.skipped, error: `no masks written — profile baked for "${args.asset}"? sidecar returned ${resp.masks?.length ?? 0} masks` };
  }
  return { ok: true, added, skipped: resp.skipped };
}

// ── plumb_study_take — drain the "Study with AI" button's request queue ──────

export const plumbStudyTakeSchema = {};
export async function plumbStudyTakeHandler(): Promise<{ requests: Array<{ asset: string; ts: string }>; note: string }> {
  const requests = takeStudyRequests();
  return {
    requests,
    note: requests.length
      ? 'For each asset: call plumb_study, then propose masks (plumb_mask_add) + constraints (plumb_constraint_define). The Studio auto-refreshes when the stores change.'
      : 'No pending study requests. The "Study with AI" button in the Semantic Studio enqueues them.',
  };
}

// ── Lessons (the [[slug]] knowledge constraints cite) ────────────────────────

export const plumbLessonAddSchema = {
  slug: z.string().describe('kebab/snake-case id, matches [[slug]] refs'),
  title: z.string(),
  body: z.string().describe('Human-readable explanation of the lesson'),
  refs: z.array(z.string()).optional().describe('Related slugs or asset paths'),
  tags: z.array(z.string()).optional(),
};
export async function plumbLessonAddHandler(args: { slug: string; title: string; body: string; refs?: string[]; tags?: string[] }, nowIso: string): Promise<{ ok: boolean; errors?: unknown[] }> {
  const r = upsertLesson({ slug: args.slug, title: args.title, body: args.body, refs: args.refs, tags: args.tags }, nowIso);
  return r.ok ? { ok: true } : { ok: false, errors: r.errors };
}

export const plumbLessonListSchema = {};
export async function plumbLessonListHandler(): Promise<{ lessons: Array<{ slug: string; title: string; refs?: string[] }> }> {
  return { lessons: loadLessons().map(l => ({ slug: l.slug, title: l.title, refs: l.refs })) };
}

export const plumbLessonRemoveSchema = { slug: z.string() };
export async function plumbLessonRemoveHandler(args: { slug: string }): Promise<{ ok: boolean; removed: boolean }> {
  return { ok: true, removed: removeLesson(args.slug) };
}

// ── plumb_production_define / list / remove ──────────────────────────────────

const emitOpSchema = z.object({
  emit: z.enum(['shell', 'asset', 'symbol', 'scatter', 'decal', 'fill']),
  role: z.string().optional(),
  kind: z.string().optional(),
  tag: z.string().optional(),
  at: z.string().optional(),
  along: z.string().optional(),
  spacing_m: z.number().optional(),
  alternate: z.boolean().optional(),
  len: z.number().optional(),
  profile_curve: z.string().optional(),
  thickness_by: z.string().optional(),
  bend_at_m: z.number().optional(),
});

export const plumbProductionDefineSchema = {
  id: z.string(),
  lhs: z.object({
    kind: z.string(),
    when: z.record(z.unknown()).optional(),
  }),
  rhs: z.array(emitOpSchema).min(1),
  guards: z.array(z.string()).optional().describe('Constraint ids that must pass before this production fires'),
  priority: z.number().describe('Higher priority = tried first when multiple productions match'),
};
export async function plumbProductionDefineHandler(args: {
  id: string;
  lhs: { kind: string; when?: Record<string, unknown> };
  rhs: Record<string, unknown>[];
  guards?: string[];
  priority: number;
}): Promise<{ ok: boolean; errors?: string[] }> {
  const p: Production = {
    id: args.id,
    lhs: args.lhs,
    rhs: args.rhs as Production['rhs'],
    guards: args.guards ?? [],
    priority: args.priority,
  };
  const errs = validateProduction(p);
  if (errs.length) return { ok: false, errors: errs };
  putProduction(p);
  return { ok: true };
}

export const plumbProductionListSchema = {};
export async function plumbProductionListHandler(): Promise<{ productions: Production[] }> {
  return { productions: listProductions() };
}

export const plumbProductionRemoveSchema = { id: z.string() };
export async function plumbProductionRemoveHandler(args: { id: string }): Promise<{ ok: boolean; removed: boolean }> {
  return { ok: true, removed: removeProduction(args.id) };
}

// ── plumb_socket_add ─────────────────────────────────────────────────────────

export const plumbSocketAddSchema = {
  asset: z.string().describe('Asset path the socket belongs to (must have a baked profile)'),
  socket: z.object({
    id: z.string(),
    type: z.enum(['floor', 'ceiling', 'wall', 'edge', 'custom']),
    frame: z.object({ pos: vec3, quat: vec4 }),
  }),
};
export async function plumbSocketAddHandler(args: {
  asset: string;
  socket: Socket;
}): Promise<{ ok: boolean; profile?: unknown; error?: string }> {
  try {
    const merged = addSocketToProfile(args.asset, args.socket);
    return { ok: true, profile: merged };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── plumb_grammar_expand ──────────────────────────────────────────────────────

export const plumbGrammarExpandSchema = {
  seed: z.object({
    kind: z.string(),
    attrs: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
  }).describe('Seed symbol to expand from'),
};
export async function plumbGrammarExpandHandler(args: {
  seed: { kind: string; attrs?: Record<string, number | string | boolean> };
}): Promise<{ plan: unknown; note: string }> {
  const seed = { kind: args.seed.kind, attrs: args.seed.attrs ?? {} };
  const prods = listProductions();
  const guard = makeGuardFn();
  const plan = expandGrammar(seed, prods, guard);
  return {
    plan,
    note: prods.length === 0
      ? 'No productions defined yet — call plumb_production_define to author rules, then re-expand.'
      : `Expanded from seed "${seed.kind}" using ${prods.length} production(s). In dry-run, geometry primitives (max_straight_run, presence) self-skip — rejections shown only reflect constraints evaluable without a UE scene.`,
  };
}

void constraintsFor; void primitivesById; void getLesson; // re-exported helpers, kept for tool growth
