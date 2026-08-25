// world_generate — the flagship "describe a biome, get a validated scene" tool.
//
// What makes this different from a plain scatter (Nwiro/Flop): the placement is
// PLUMB-VALIDATED and auto-corrected IN MEMORY before anything is spawned, so
// every instance is proven (grounded, non-interpenetrating) — "scatter AND
// prove", not scatter-and-hope. The deterministic core (parse → plan →
// validate → fix) is pure and unit-tested; only the final spawn touches UE.
//
// Pipeline:
//   1. parse the prompt into biome layers (canopy / rock / undergrowth / ground)
//   2. resolve one StaticMesh per layer from the project (owned-first; a missing
//      layer is reported as a gap, never fatal)
//   3. bake a PLUMB profile per asset from its mesh bounds (best-effort)
//   4. plan a deterministic scatter (seeded) across the area
//   5. validate the plan with PLUMB and apply its fix vectors, re-validating
//      until clean or a pass cap — corrections happen on the PLAN, pre-spawn
//   6. spawn the corrected transforms (skipped on dry_run)

import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import { conformToGround } from './terrain-conform.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { evaluatePerInstance, bakeProfile } from '../../plumb/index.js';
import type { InstanceState, Constraint, Profile } from '../../plumb/contracts.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['modifies_scene'],
  when: 'building an environment from a natural-language biome description (e.g. "lakeside hemlock forest with dense fern undergrowth, boulders and mossy branches") — places PLUMB-validated, auto-corrected instances of the project\'s own meshes across an area',
  not_when: 'placing a single known asset (use actor_spawn) or authoring a PCG graph by hand (use the pcg tools)',
};

// ── biome taxonomy (pure) ─────────────────────────────────────────────────────
interface TaxonEntry { role: string; match: RegExp; weight: number; scaleMin: number; scaleMax: number; }
const TAXONOMY: TaxonEntry[] = [
  { role: 'canopy',      match: /\b(trees?|pines?|oaks?|hemlocks?|firs?|spruces?|birch|cedar|forest|canopy)\b/i, weight: 0.18, scaleMin: 0.8, scaleMax: 1.4 },
  { role: 'rock',        match: /\b(rocks?|boulders?|stones?|scree|cliff|cliffs)\b/i,                           weight: 0.12, scaleMin: 0.5, scaleMax: 1.6 },
  { role: 'undergrowth', match: /\b(ferns?|bush(?:es)?|shrubs?|undergrowth|grass|reeds?|saplings?)\b/i,         weight: 0.45, scaleMin: 0.7, scaleMax: 1.2 },
  { role: 'groundcover', match: /\b(moss|mushrooms?|flowers?|pebbles?|debris|leaf|leaves|branch(?:es)?|logs?|roots?)\b/i, weight: 0.25, scaleMin: 0.6, scaleMax: 1.1 },
];

export interface BiomeLayer { role: string; keywords: string[]; weight: number; scaleMin: number; scaleMax: number; }

/** Parse a biome prompt into the layers it mentions, with the exact nouns to
 *  search for (so "hemlock" searches hemlock, not a generic "tree"). Pure. */
export function parseBiomePrompt(prompt: string): BiomeLayer[] {
  const layers: BiomeLayer[] = [];
  for (const t of TAXONOMY) {
    const found = new Set<string>();
    const re = new RegExp(t.match.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt)) !== null) { found.add(m[0].toLowerCase()); if (m.index === re.lastIndex) re.lastIndex++; }
    if (found.size > 0) layers.push({ role: t.role, keywords: [...found], weight: t.weight, scaleMin: t.scaleMin, scaleMax: t.scaleMax });
  }
  return layers;
}

/** Deterministic PRNG (mulberry32) so the same seed reproduces the same scene. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Placement {
  object: string;
  asset: string;
  role: string;
  loc_cm: [number, number, number];
  yaw_deg: number;
  scale: number;
}

function yawToQuat(yawDeg: number): [number, number, number, number] {
  const h = (yawDeg * Math.PI) / 180 / 2;
  return [0, 0, Math.sin(h), Math.cos(h)];
}

/** Deterministically scatter `count` instances across a disc of `radius_cm`
 *  about `center_cm`, split across layers by weight. Only layers with a
 *  resolved asset are placed. Pure. */
export function planScatter(
  layers: BiomeLayer[],
  assetByRole: Record<string, string>,
  center_cm: [number, number, number],
  radius_cm: number,
  count: number,
  seed: number,
): Placement[] {
  const rng = makeRng(seed);
  const active = layers.filter((l) => assetByRole[l.role]);
  const wsum = active.reduce((s, l) => s + l.weight, 0) || 1;
  const out: Placement[] = [];
  let idx = 0;
  for (const l of active) {
    const n = Math.max(1, Math.round((count * l.weight) / wsum));
    for (let i = 0; i < n; i++) {
      const ang = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * radius_cm; // sqrt → uniform area density
      const x = center_cm[0] + Math.cos(ang) * r;
      const y = center_cm[1] + Math.sin(ang) * r;
      const scale = Number((l.scaleMin + rng() * (l.scaleMax - l.scaleMin)).toFixed(3));
      out.push({ object: `WG_${l.role}_${idx++}`, asset: assetByRole[l.role], role: l.role, loc_cm: [x, y, center_cm[2]], yaw_deg: Number((rng() * 360).toFixed(1)), scale });
    }
  }
  return out;
}

function toInstanceState(p: Placement): InstanceState {
  return { object: p.object, asset: p.asset, transform: { pos: [p.loc_cm[0] / 100, p.loc_cm[1] / 100, p.loc_cm[2] / 100], quat: yawToQuat(p.yaw_deg), scale: [p.scale, p.scale, p.scale] } };
}

export interface ValidationSummary { passes: number; failed_before: number; failed_after: number; fixed: number; ran: boolean; note?: string; }

/** Validate the plan against the constraints and apply PLUMB's fix vectors to
 *  the planned positions, re-validating up to `maxPasses`. Mutates the loc_cm of
 *  `placements` in place (corrections are pre-spawn). Pure given profiles. Pure. */
export function validateAndFix(
  placements: Placement[],
  constraints: Constraint[],
  profiles: Map<string, Profile>,
  maxPasses = 3,
): ValidationSummary {
  if (constraints.length === 0) return { passes: 0, failed_before: 0, failed_after: 0, fixed: 0, ran: false, note: 'no profiles baked — validation skipped (placement still occurs)' };

  const byObject = new Map(placements.map((p) => [p.object, p]));
  const instances = placements.map(toInstanceState);
  const stateByObject = new Map(instances.map((s) => [s.object, s]));

  const countFailing = () => evaluatePerInstance(instances, constraints, { profiles }).filter((v) => !v.ok).length;
  const failedBefore = countFailing();

  let fixed = 0;
  let pass = 0;
  for (; pass < maxPasses; pass++) {
    const verdicts = evaluatePerInstance(instances, constraints, { profiles });
    const bad = verdicts.filter((v) => !v.ok && (v.fix[0] || v.fix[1] || v.fix[2]));
    if (bad.length === 0) break;
    for (const v of bad) {
      const s = stateByObject.get(v.object);
      const p = byObject.get(v.object);
      if (!s || !p) continue;
      s.transform.pos = [s.transform.pos[0] + v.fix[0], s.transform.pos[1] + v.fix[1], s.transform.pos[2] + v.fix[2]];
      p.loc_cm = [s.transform.pos[0] * 100, s.transform.pos[1] * 100, s.transform.pos[2] * 100];
      fixed++;
    }
  }
  return { passes: pass, failed_before: failedBefore, failed_after: countFailing(), fixed, ran: true };
}

// ── UE adapters (defensive — degrade to gaps/reports, never throw) ────────────
async function resolveOwnedMesh(keywords: string[]): Promise<string | null> {
  for (const kw of keywords) {
    try {
      const r = await executeCommand<Record<string, unknown>>('asset_search', { query: kw, type: 'StaticMesh' });
      const list = (r?.assets ?? r?.results ?? r?.items) as Array<Record<string, unknown>> | undefined;
      const first = Array.isArray(list) ? list[0] : undefined;
      const path = (first?.path ?? first?.object_path ?? first?.objectPath) as string | undefined;
      if (path) return path;
    } catch { /* try next keyword */ }
  }
  return null;
}

async function bakeProfileFor(asset: string, nowIso: string): Promise<Profile | null> {
  try {
    const info = await executeCommand<Record<string, unknown>>('mesh_get_info', { path: asset });
    const b = info?.bounds as { min?: Record<string, number>; max?: Record<string, number>; extents?: Record<string, number> } | undefined;
    if (!b?.min || !b?.max) return null;
    const origin: [number, number, number] = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];
    const extent: [number, number, number] = [(b.max.x - b.min.x) / 2, (b.max.y - b.min.y) / 2, (b.max.z - b.min.z) / 2];
    return bakeProfile({ asset_id: asset, origin_cm: origin, extent_cm: extent }, nowIso);
  } catch { return null; }
}

export const schema = z.object({
  area_actor: z.string().min(1).describe('Label of an actor whose location is the centre of the biome region'),
  prompt: z.string().min(1).describe('Natural-language biome description, e.g. "lakeside hemlock forest with dense fern undergrowth, boulders and mossy branches"'),
  radius_cm: z.number().positive().optional().describe('Scatter radius around the area actor in cm (default 1500)'),
  count: z.number().int().positive().optional().describe('Total instances to place across all layers (default 40)'),
  seed: z.number().int().optional().describe('Deterministic seed (default 1337)'),
  ground_tolerance_m: z.number().positive().optional().describe('Grounded constraint tolerance in metres (default 0.1)'),
  dry_run: z.boolean().optional().describe('Plan + validate only; do not spawn'),
});

export async function worldGenerateHandler(args: Record<string, unknown>, _session?: SessionManager): Promise<ToolResult> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  const { area_actor, prompt } = parsed.data;
  const radius = parsed.data.radius_cm ?? 1500;
  const count = parsed.data.count ?? 40;
  const seed = parsed.data.seed ?? 1337;
  const tol = parsed.data.ground_tolerance_m ?? 0.1;
  const dryRun = parsed.data.dry_run ?? false;
  const nowIso = '1970-01-01T00:00:00.000Z'; // stamp deterministically; profiles are ephemeral here

  // 1. parse
  const layers = parseBiomePrompt(prompt);
  if (layers.length === 0) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'prompt matched no biome layers (canopy/rock/undergrowth/groundcover). Mention trees, rocks, ferns/grass, moss/branches, etc.' }, null, 2) }], isError: true };
  }

  // 2. area centre (actor location)
  let center: [number, number, number] = [0, 0, 0];
  try {
    const r = await executeCommand<Record<string, unknown>>('actor_list', {});
    const actors = (r?.actors as Array<Record<string, unknown>> | undefined) ?? [];
    const hit = actors.find((a) => a.label === area_actor || a.id === area_actor);
    const loc = hit?.location as { x?: number; y?: number; z?: number } | number[] | undefined;
    if (Array.isArray(loc)) center = [loc[0] ?? 0, loc[1] ?? 0, loc[2] ?? 0];
    else if (loc) center = [loc.x ?? 0, loc.y ?? 0, loc.z ?? 0];
  } catch { /* fall back to origin */ }

  // 3. resolve assets + bake profiles
  const assetByRole: Record<string, string> = {};
  const gaps: string[] = [];
  const profiles = new Map<string, Profile>();
  for (const l of layers) {
    const mesh = await resolveOwnedMesh(l.keywords);
    if (!mesh) { gaps.push(`${l.role} (${l.keywords.join('/')})`); continue; }
    assetByRole[l.role] = mesh;
    const prof = await bakeProfileFor(mesh, nowIso);
    if (prof) profiles.set(mesh, prof);
  }

  if (Object.keys(assetByRole).length === 0) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'no owned StaticMesh matched any biome layer', gaps, layers: layers.map((l) => l.role) }, null, 2) }], isError: true };
  }

  // 4. plan
  const planned = planScatter(layers, assetByRole, center, radius, count, seed);

  // 5. separate same-asset overlaps, BEFORE grounding.
  //
  // A clearance fix pushes in XY, so doing this after the trace would slide
  // instances off the exact surface point they were just placed on. Order
  // matters more than it looks.
  //
  // Bound per asset and filtered to the same asset: this proves two hemlocks
  // are not inside each other. It does NOT prove a fern is outside a tree
  // trunk -- cross-asset interpenetration needs real overlap, not a
  // centre-distance proxy, and the tool's description now says so rather than
  // implying more than is checked.
  const clearanceConstraints: Constraint[] = [];
  for (const l of layers) {
    const asset = assetByRole[l.role];
    if (!asset) continue;
    const prof = profiles.get(asset);
    if (!prof) continue; // no geometry, no honest claim
    const bb = prof.geometry.aabb;
    const halfX = (bb.max[0] - bb.min[0]) / 2;
    const halfY = (bb.max[1] - bb.min[1]) / 2;
    // Footprint proxy at the layer's largest scale, so the separation holds
    // for the biggest instance the layer can produce rather than the average.
    const min_m = 2 * Math.max(halfX, halfY) * l.scaleMax;
    if (!(min_m > 0)) continue;
    clearanceConstraints.push({
      id: `wg_clearance_${asset}`,
      primitive: 'clearance',
      params: { min_m: Number(min_m.toFixed(3)), asset },
      binding: { asset },
    });
  }
  const separation = validateAndFix(planned, clearanceConstraints, profiles);

  // 6. sit each base on the traced ground.
  //
  // The trace returns the surface; the placement is a PIVOT. Setting the pivot
  // to the surface buries or floats anything whose pivot is not at its base --
  // the SM_GiantTree pivot sits ~3.8m above the roots. ground_offset_m is the
  // signed pivot-to-base distance, scaled with the instance.
  const conform = await conformToGround(
    planned.map((p) => [p.loc_cm[0], p.loc_cm[1]] as const),
    center[2],
  );

  let placements = planned;
  const noGround: string[] = [];
  if (!conform.unavailable) {
    placements = [];
    for (const [i, p] of planned.entries()) {
      const groundZ = conform.hits[i]?.z ?? null;
      if (groundZ === null) { noGround.push(p.object); continue; }
      const offsetM = profiles.get(p.asset)?.structural?.ground_offset_m ?? 0;
      const pivotZ = groundZ - offsetM * p.scale * 100;
      placements.push({ ...p, loc_cm: [p.loc_cm[0], p.loc_cm[1], pivotZ] });
    }
  }

  if (placements.length === 0) {
    return { content: [{ type: 'text', text: JSON.stringify({
      ok: false,
      error: 'every planned point had nothing under it to stand on — is there ground beneath the area actor?',
      planned: planned.length,
      no_ground: noGround.length,
    }, null, 2) }], isError: true };
  }

  // 7. the grounded constraint measures the base against the WORLD PLANE z=0.
  //
  // That is the right check on flat ground and the wrong one on terrain: after
  // a conform onto a hillside at z=4.5m it fails every instance and "fixes"
  // them by dragging them back down to zero, undoing the trace. So it runs
  // only on the unconformed fallback path, where its flat-world assumption is
  // the situation. When the trace ran, groundedness comes from the trace and
  // the report says which one happened.
  const validation = conform.unavailable
    ? validateAndFix(
        placements,
        Object.values(assetByRole).map((a) => ({
          id: `wg_grounded_${a}`, primitive: 'grounded', params: { tolerance_m: tol }, binding: { asset: a },
        })),
        profiles,
      )
    : { passes: 0, failed_before: 0, failed_after: 0, fixed: 0, ran: false,
        note: 'grounded by terrain trace, not by the z=0 plane check' };

  const report: Record<string, unknown> = {
    ok: true,
    area_actor, center_cm: center, radius_cm: radius, seed,
    layers: layers.map((l) => ({ role: l.role, keywords: l.keywords, asset: assetByRole[l.role] ?? null })),
    gaps,
    separation: clearanceConstraints.length === 0
      ? { ran: false, note: 'no baked geometry — same-asset clearance not checked' }
      : { checked: 'same-asset centre distance', ...separation },
    terrain: conform.unavailable
      ? { conformed: false, reason: conform.unavailable, note: 'placements kept the area actor height and are NOT grounded to the world' }
      : { conformed: true, planned: planned.length, placed: placements.length, dropped_no_ground: noGround.length },
    planned: placements.length,
    validation,
    dry_run: dryRun,
  };

  if (dryRun) {
    report.sample = placements.slice(0, 5);
    return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
  }

  // 6. place as Instanced Static Meshes — one ISM actor per resolved mesh, mesh
  //    set at creation, the VALIDATED transforms added as instances. ISM is the
  //    right primitive for biome density and composes with pre-spawn validation;
  //    it also actually renders (actor_set_properties cannot set a component's
  //    StaticMesh, so the spawn+set path would place empty actors).
  const byAsset = new Map<string, Placement[]>();
  for (const p of placements) { const a = byAsset.get(p.asset) ?? []; a.push(p); byAsset.set(p.asset, a); }

  let ismActors = 0; let instances = 0; const placeErrors: string[] = [];
  for (const [asset, ps] of byAsset) {
    try {
      const leaf = asset.split('/').pop()?.split('.').pop() ?? 'mesh';
      const created = await executeCommand<Record<string, unknown>>('ism_create_actor', { static_mesh_path: asset, label: `WG_${ps[0].role}_${leaf}`, location: center });
      const actorId = (created?.actor_id ?? created?.id) as string | undefined;
      if (!actorId) { placeErrors.push(`${asset}: ism_create_actor returned no actor_id`); continue; }
      ismActors++;
      const transforms = ps.map((p) => ({ location: p.loc_cm, rotation: [0, p.yaw_deg, 0], scale: [p.scale, p.scale, p.scale] }));
      for (let i = 0; i < transforms.length; i += 1000) { // ism_add_instances caps at 1000/call
        const chunk = transforms.slice(i, i + 1000);
        const added = await executeCommand<Record<string, unknown>>('ism_add_instances', { actor_id: actorId, transforms: chunk });
        instances += (added?.added as number | undefined) ?? chunk.length;
      }
    } catch (e) {
      placeErrors.push(`${asset}: ${(e as Error)?.message ?? String(e)}`);
    }
  }
  report.ism_actors = ismActors;
  report.instances = instances;
  if (placeErrors.length > 0) report.place_errors = placeErrors.slice(0, 10);

  return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
}
