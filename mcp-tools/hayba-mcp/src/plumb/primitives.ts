// The constraint LANGUAGE — a CLOSED set of primitive predicates.
//
// This is the whole grammar. There are no operators, no composition, no
// user-written logic: a constraint is a primitive id + a bag of numeric params
// + a binding. Authoring fills values. That is the anti-flop, anti-rot
// guarantee — an AI (or human) can only pick from this fixed menu and fill
// numbers, so it cannot invent broken logic. Generality comes from BINDING
// (primitives.ts is small; the library of bound constraints grows).
//
// Every primitive returns a signed `value_m` (>=0 means satisfied — the margin)
// and, when violated, a `fix` telling the caller which way to push. Deterministic
// primitives read only geometry/transforms; qualitative ones read the AI-baked
// profile semantics and carry confidence + lock (and cannot hard-gate unless the
// human locked the field — stops hallucinated semantics from blocking commits).

import type {
  Constraint, ConstraintResult, FixVector, GateName,
  InstanceState, Profile, SceneContext, Transform,
} from './contracts.js';

// ── tiny vector / quaternion math (Z-up, quats are [x,y,z,w]) ────────────────

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const dist = (a: V3, b: V3): number => len(sub(a, b));
const distXY = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** Shortest-arc quaternion rotating `from` onto `to`, as [x,y,z,w].
 *
 *  Used by the rotation fixes. The antiparallel case needs care: the cross
 *  product is zero there, so the axis has to be picked rather than derived,
 *  and skipping that check yields a zero quaternion that silently rotates
 *  nothing -- a fix that reports success and does not fix. */
function quatFromTo(from: V3, to: V3): [number, number, number, number] {
  const a = norm(from);
  const b = norm(to);
  const d = Math.max(-1, Math.min(1, dot(a, b)));
  if (d > 0.999999) return [0, 0, 0, 1];               // already aligned
  if (d < -0.999999) {
    // Opposed: any perpendicular axis is a valid 180-degree rotation.
    let axis = cross(a, [1, 0, 0]);
    if (len(axis) < 1e-6) axis = cross(a, [0, 1, 0]);
    const n = norm(axis);
    return [n[0], n[1], n[2], 0];
  }
  const axis = cross(a, b);
  const w = 1 + d;
  const l = Math.hypot(axis[0], axis[1], axis[2], w) || 1;
  return [axis[0] / l, axis[1] / l, axis[2] / l, w / l];
}

const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Rotate vector v by unit quaternion q ([x,y,z,w]). */
function rotate(q: [number, number, number, number], v: V3): V3 {
  const [x, y, z, w] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  // v + w*t + cross(q.xyz, t)
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

const DEG = 180 / Math.PI;

// ── primitive interface ──────────────────────────────────────────────────────

export interface PrimitiveContext {
  constraint: Constraint;
  instance: InstanceState;
  profile: Profile | null;   // null when the asset has no baked profile
  scene: SceneContext;
}

/** What a primitive evaluator returns (the verdict layer wraps this). */
export interface PrimitiveOutcome {
  value_m: number;           // signed margin (>=0 satisfied); 0 when skipped
  fix?: FixVector;
  detail?: string;
  viz?: string;              // viewport viz hint
  confidence?: number;       // qualitative only
  /** Skip — preconditions missing (e.g. no profile/footprint). Not a failure. */
  skip?: boolean;
  skipReason?: string;
}

const SKIP = (reason: string): PrimitiveOutcome => ({ value_m: 0, skip: true, skipReason: reason });

export interface Primitive {
  id: string;
  gate: GateName;
  /** Default hard/soft; a constraint may override via `hard`. */
  defaultHard: boolean;
  /** True for profile-semantics-backed primitives (confidence + lock apply). */
  qualitative: boolean;
  /** Short docstring for catalog/propose tooling. */
  doc: string;
  /** Param names this primitive reads (for validation + propose). */
  params: string[];
  evaluate: (ctx: PrimitiveContext) => PrimitiveOutcome;
}

const num = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Base world-z of an instance's contact surface (pivot z + ground_offset). */
function baseZ(inst: InstanceState, profile: Profile | null): number {
  const off = profile?.structural?.ground_offset_m ?? 0;
  const sz = inst.transform.scale[2] || 1;
  return inst.transform.pos[2] + off * sz;
}

/** Instances in the scene matching an asset/tag filter (excludes self). */
function matchFilter(scene: SceneContext, self: string, filter: { asset?: string; axis?: string; value?: string }): InstanceState[] {
  return scene.instances.filter(i => {
    if (i.object === self) return false;
    if (filter.asset) return i.asset === filter.asset;
    if (filter.axis && filter.value) return i.tags?.[filter.axis] === filter.value;
    return true; // no filter → all others
  });
}

/** Resolve an axis-aligned region {center,extents} (metres, world) from a mask
 *  on the instance's profile. Returns null when the mask/shape is absent. */
function maskRegion(profile: Profile | null, maskId: string | undefined, inst: InstanceState): { center: V3; extents: V3 } | null {
  if (!maskId) return null;
  const m = profile?.masks?.find(x => x.id === maskId);
  if (!m) return null;
  if (m.type === 'volume' && m.shape) {
    const t = m.shape.transform;
    const ext = m.shape.extents ?? [m.shape.radius ?? 0.5, m.shape.radius ?? 0.5, m.shape.radius ?? 0.5];
    return {
      center: [inst.transform.pos[0] + t.pos[0], inst.transform.pos[1] + t.pos[1], inst.transform.pos[2] + t.pos[2]],
      extents: ext as V3,
    };
  }
  return null; // surface masks are handled by surface_contact / affordance_clear paths
}

// ── the closed set (13 primitives) ───────────────────────────────────────────

export const PRIMITIVES: Primitive[] = [
  {
    id: 'grounded',
    gate: 'stability',
    defaultHard: true,
    qualitative: false,
    doc: 'Object base must sit on the ground plane (z=0) within tolerance. Encodes pivot offsets (e.g. SM_GiantTree_01 = -3.8m) so the lesson is enforced, not remembered.',
    params: ['tolerance_m'],
    evaluate: ({ constraint, instance, profile }) => {
      const tol = num(constraint.params.tolerance_m, 0.05);
      const bz = baseZ(instance, profile);          // signed gap from ground
      const value_m = tol - Math.abs(bz);
      return {
        value_m,
        fix: value_m < 0 ? { translate: [0, 0, -bz] } : undefined,
        detail: `base z=${bz.toFixed(3)}m (tol ±${tol}m)`,
      };
    },
  },
  {
    id: 'clearance',
    gate: 'collision',
    defaultHard: true,
    qualitative: false,
    doc: 'Centre-to-centre distance to other (optionally filtered) instances must be >= min_m. Coarse proxy for non-penetration until OBB overlap is wired.',
    params: ['min_m', 'asset', 'tag_axis', 'tag_value'],
    evaluate: ({ constraint, instance, scene }) => {
      const min = num(constraint.params.min_m, 1);
      const others = matchFilter(scene, instance.object, {
        asset: str(constraint.params.asset),
        axis: str(constraint.params.tag_axis),
        value: str(constraint.params.tag_value),
      });
      if (others.length === 0) return SKIP('no other instances match filter');
      let nearest = others[0], best = Infinity;
      for (const o of others) {
        const d = dist(instance.transform.pos, o.transform.pos);
        if (d < best) { best = d; nearest = o; }
      }
      const value_m = best - min;
      let fix: FixVector | undefined;
      if (value_m < 0) {
        const away = norm(sub(instance.transform.pos, nearest.transform.pos));
        const push = -value_m;
        fix = { translate: [away[0] * push, away[1] * push, away[2] * push] };
      }
      return { value_m, fix, detail: `nearest ${best.toFixed(2)}m vs min ${min}m` };
    },
  },
  {
    id: 'support_margin',
    gate: 'stability',
    defaultHard: true,
    qualitative: false,
    doc: 'Horizontal distance from the centre of mass to the edge of the support footprint must exceed min_m (topple resistance). Needs a baked support_footprint.',
    params: ['min_m'],
    evaluate: ({ constraint, instance, profile }) => {
      const min = num(constraint.params.min_m, 0.02);
      const foot = profile?.structural?.support_footprint;
      if (!foot || foot.length < 3) return SKIP('no support_footprint in profile');
      const com = profile?.physical?.com ?? [0, 0, 0];
      const margin = polygonMargin(foot, [com[0], com[1]]); // +inside, -outside
      const value_m = margin - min;

      // Move the object so its centre of mass sits back over the footprint.
      // Direction is toward the footprint centroid, which is inside any convex
      // support polygon and is the direction that gains margin fastest.
      let fix: FixVector | undefined;
      if (value_m < 0) {
        let cx = 0, cy = 0;
        for (const v of foot) { cx += v[0]; cy += v[1]; }
        cx /= foot.length; cy /= foot.length;
        const toward = norm([cx - com[0], cy - com[1], 0]);
        const need = -value_m;
        fix = { translate: [toward[0] * need, toward[1] * need, 0] };
      }
      return {
        value_m,
        fix,
        viz: value_m < 0 ? 'com_outside_polygon' : undefined,
        detail: `CoM margin ${margin.toFixed(3)}m vs min ${min}m`,
      };
    },
  },
  {
    id: 'upright',
    gate: 'stability',
    defaultHard: false,
    qualitative: false,
    doc: 'Tilt of the object up-axis away from world-up must stay under max_deg.',
    params: ['max_deg'],
    evaluate: ({ constraint, instance, profile }) => {
      const maxDeg = num(constraint.params.max_deg, 5);
      const localUp = (profile?.semantics?.up ?? [0, 0, 1]) as V3;
      const worldUp = rotate(instance.transform.quat, localUp);
      const tilt = Math.acos(Math.max(-1, Math.min(1, dot(norm(worldUp), [0, 0, 1])))) * DEG;
      const value_m = maxDeg - tilt;   // margin in degrees (kept in value_m slot)

      // A rotation, not a translation. Moving a leaning object does not make it
      // upright -- this is why FixVector carries rotate_quat, and why a rule
      // whose fix is angular must not emit a translate.
      const fix: FixVector | undefined = value_m < 0
        ? { translate: [0, 0, 0], rotate_quat: quatFromTo(norm(worldUp), [0, 0, 1]) }
        : undefined;
      return { value_m, fix, detail: `tilt ${tilt.toFixed(1)}° vs max ${maxDeg}°` };
    },
  },
  {
    id: 'scale_range',
    gate: 'constraints',
    defaultHard: false,
    qualitative: false,
    doc: 'Uniform (or per-axis) scale must lie within [min, max].',
    params: ['min', 'max', 'axis'],
    evaluate: ({ constraint, instance }) => {
      const lo = num(constraint.params.min, 0.1);
      const hi = num(constraint.params.max, 10);
      const axisName = str(constraint.params.axis);
      const sc = instance.transform.scale;
      const s = axisName === 'x' ? sc[0] : axisName === 'y' ? sc[1] : axisName === 'z' ? sc[2]
        : (sc[0] + sc[1] + sc[2]) / 3;
      const value_m = Math.min(s - lo, hi - s);
      return { value_m, detail: `scale ${s.toFixed(2)} vs [${lo}, ${hi}]` };
    },
  },
  {
    id: 'count_per_m2',
    gate: 'constraints',
    defaultHard: false,
    qualitative: false,
    doc: 'Density of matching instances per square metre must not exceed max. area_m2 is the region the count is measured over.',
    params: ['max', 'area_m2', 'asset', 'tag_axis', 'tag_value'],
    evaluate: ({ constraint, instance, scene }) => {
      const max = num(constraint.params.max, 1);
      const area = Math.max(1e-6, num(constraint.params.area_m2, 1));
      const matches = matchFilter(scene, instance.object, {
        asset: str(constraint.params.asset),
        axis: str(constraint.params.tag_axis),
        value: str(constraint.params.tag_value),
      });
      const density = (matches.length + 1) / area;  // include self
      const value_m = max - density;
      return { value_m, detail: `${density.toFixed(3)}/m² vs max ${max}/m²` };
    },
  },
  {
    id: 'proximity',
    gate: 'constraints',
    defaultHard: false,
    qualitative: false,
    doc: 'Horizontal distance to the nearest matching target must fall within [min_m, max_m] (either bound optional).',
    params: ['min_m', 'max_m', 'asset', 'tag_axis', 'tag_value'],
    evaluate: ({ constraint, instance, scene }) => {
      const targets = matchFilter(scene, instance.object, {
        asset: str(constraint.params.asset),
        axis: str(constraint.params.tag_axis),
        value: str(constraint.params.tag_value),
      });
      if (targets.length === 0) return SKIP('no proximity targets match filter');
      // Track WHICH target is nearest, not just how far. The distance alone
      // cannot produce a fix, which is why this rule never offered one.
      let best = Infinity;
      let nearest = targets[0];
      for (const t of targets) {
        const d = distXY(instance.transform.pos, t.transform.pos);
        if (d < best) { best = d; nearest = t; }
      }
      const hasMin = typeof constraint.params.min_m === 'number';
      const hasMax = typeof constraint.params.max_m === 'number';
      const minM = num(constraint.params.min_m, -Infinity);
      const maxM = num(constraint.params.max_m, Infinity);
      const lowMargin = hasMin ? best - minM : Infinity;
      const highMargin = hasMax ? maxM - best : Infinity;
      const value_m = Math.min(lowMargin, highMargin);

      // Horizontal only: this rule measures with distXY, so a fix that moved
      // the object vertically would not change what it measured.
      let fix: FixVector | undefined;
      if (value_m < 0) {
        const away = norm([
          instance.transform.pos[0] - nearest.transform.pos[0],
          instance.transform.pos[1] - nearest.transform.pos[1],
          0,
        ]);
        // Too close pushes out; too far pulls in. Same axis, opposite sign.
        const push = lowMargin < highMargin ? -lowMargin : highMargin;
        fix = { translate: [away[0] * push, away[1] * push, 0] };
      }
      return { value_m, fix, detail: `nearest ${best.toFixed(2)}m vs [${hasMin ? minM : '–'}, ${hasMax ? maxM : '–'}]` };
    },
  },
  {
    id: 'inside_outside',
    gate: 'constraints',
    defaultHard: false,
    qualitative: false,
    doc: 'Instance must be inside (mode=inside) or outside (mode=outside) an axis-aligned region box {center,extents} or a referenced volume mask.',
    params: ['center', 'extents', 'mode', 'mask'],
    evaluate: ({ constraint, instance, profile }) => {
      const region = maskRegion(profile, str(constraint.params.mask), instance);
      const center = region?.center ?? ((constraint.params.center as V3) ?? [0, 0, 0]);
      const extents = region?.extents ?? ((constraint.params.extents as V3) ?? [1, 1, 1]);
      const mode = str(constraint.params.mode) === 'outside' ? 'outside' : 'inside';
      // signed distance to box surface, +inside
      const p = instance.transform.pos;
      const dx = extents[0] - Math.abs(p[0] - center[0]);
      const dy = extents[1] - Math.abs(p[1] - center[1]);
      const inside = Math.min(dx, dy);   // horizontal containment
      const value_m = mode === 'inside' ? inside : -inside;

      // Move along the cheapest axis. For "inside", that is whichever axis the
      // object has fallen outside of; for "outside", whichever edge is nearest,
      // because leaving by the near side is the smallest correction.
      let fix: FixVector | undefined;
      if (value_m < 0) {
        const need = -value_m;
        // The same test in both modes, which is easy to misread as a
        // copy-paste slip. It is not: for "inside" the smaller value is the
        // axis the object has fallen outside of, and for "outside" it is the
        // nearest face to leave by. Both want the minimum.
        const useX = dx < dy;
        const sign = useX
          ? Math.sign(p[0] - center[0]) || 1
          : Math.sign(p[1] - center[1]) || 1;
        // Inside pulls back toward the centre; outside pushes further away.
        const dir = mode === 'inside' ? -sign : sign;
        fix = { translate: useX ? [dir * need, 0, 0] : [0, dir * need, 0] };
      }
      return { value_m, fix, detail: `${mode} region (margin ${inside.toFixed(2)}m)` };
    },
  },
  {
    id: 'facing',
    gate: 'constraints',
    defaultHard: false,
    qualitative: true,
    doc: 'QUALITATIVE: the object front must point toward a target within max_deg. Uses the AI-baked front vector; cannot hard-gate unless semantics.front is locked.',
    params: ['max_deg', 'asset', 'tag_axis', 'tag_value'],
    evaluate: ({ constraint, instance, profile, scene }) => {
      const maxDeg = num(constraint.params.max_deg, 30);
      const targets = matchFilter(scene, instance.object, {
        asset: str(constraint.params.asset),
        axis: str(constraint.params.tag_axis),
        value: str(constraint.params.tag_value),
      });
      if (targets.length === 0) return SKIP('no facing target match');
      let nearest = targets[0], best = Infinity;
      for (const t of targets) { const d = distXY(instance.transform.pos, t.transform.pos); if (d < best) { best = d; nearest = t; } }
      const localFront = (profile?.semantics?.front ?? [1, 0, 0]) as V3;
      const front = norm(rotate(instance.transform.quat, localFront));
      const toTarget = norm(sub(nearest.transform.pos, instance.transform.pos));
      const ang = Math.acos(Math.max(-1, Math.min(1, dot(front, toTarget)))) * DEG;
      const value_m = maxDeg - ang;
      const locked = !!profile?.provenance?.locked?.includes('semantics.front');

      // Rotate the front vector onto the target. Only when the front is LOCKED:
      // an unlocked front is an AI guess, and turning someone's object to
      // satisfy a guess is not a fix, it is damage.
      const fix: FixVector | undefined = (value_m < 0 && locked)
        ? { translate: [0, 0, 0], rotate_quat: quatFromTo(front, toTarget) }
        : undefined;
      return { value_m, fix, confidence: profile ? 0.7 : 0.3, detail: `off-axis ${ang.toFixed(0)}° vs max ${maxDeg}° (front ${locked ? 'locked' : 'unlocked'})` };
    },
  },
  {
    id: 'affordance_clear',
    gate: 'constraints',
    defaultHard: false,
    qualitative: true,
    doc: 'QUALITATIVE: a named affordance region (door swing, seat) must not be occluded by another instance centre. Uses AI-baked affordance regions; cannot hard-gate unless that affordance is locked.',
    params: ['affordance', 'asset', 'tag_axis', 'tag_value'],
    evaluate: ({ constraint, instance, profile, scene }) => {
      const affId = str(constraint.params.affordance);
      const aff = profile?.semantics?.affordances?.find(a => a.id === affId);
      if (!aff || !aff.region) return SKIP(`affordance "${affId}" not baked in profile`);
      // affordance region is local-space; transform centre to world (no rotation
      // applied to extents — coarse, refined when OBB is wired).
      const wc: V3 = [
        instance.transform.pos[0] + aff.region.center[0],
        instance.transform.pos[1] + aff.region.center[1],
        instance.transform.pos[2] + aff.region.center[2],
      ];
      const others = matchFilter(scene, instance.object, {
        asset: str(constraint.params.asset),
        axis: str(constraint.params.tag_axis),
        value: str(constraint.params.tag_value),
      });
      let worst = Infinity;
      for (const o of others) {
        const dx = aff.region.extents[0] - Math.abs(o.transform.pos[0] - wc[0]);
        const dy = aff.region.extents[1] - Math.abs(o.transform.pos[1] - wc[1]);
        const penetration = Math.min(dx, dy);   // >0 = intruder inside region
        worst = Math.min(worst, -penetration);  // value_m = clearance, <0 = occluded
      }
      const value_m = others.length === 0 ? 1 : worst;
      const locked = !!profile?.provenance?.locked?.includes(`affordance:${affId}`);
      return { value_m, confidence: 0.6, detail: `affordance "${affId}" ${value_m < 0 ? 'occluded' : 'clear'} (${locked ? 'locked' : 'unlocked'})` };
    },
  },
  {
    id: 'surface_contact',
    gate: 'stability',
    defaultHard: true,
    qualitative: false,
    doc: 'Inverse of clearance: a glue surface must sit WITHIN max_gap_m of another surface (proper anchoring, e.g. a door against a wall). Centre-to-centre proxy until a scene-time surface trace is wired (UE).',
    params: ['max_gap_m', 'asset', 'tag_axis', 'tag_value'],
    evaluate: ({ constraint, instance, scene }) => {
      const gap = num(constraint.params.max_gap_m, 0.1);
      const others = matchFilter(scene, instance.object, {
        asset: str(constraint.params.asset),
        axis: str(constraint.params.tag_axis),
        value: str(constraint.params.tag_value),
      });
      if (others.length === 0) return SKIP('no candidate surfaces match filter');
      let nearest = others[0], best = Infinity;
      for (const o of others) {
        const d = dist(instance.transform.pos, o.transform.pos);
        if (d < best) { best = d; nearest = o; }
      }
      const value_m = gap - best;          // >=0 when within the gap (in contact)
      let fix: FixVector | undefined;
      if (value_m < 0) {
        const toward = norm(sub(nearest.transform.pos, instance.transform.pos));
        const pull = -value_m;
        fix = { translate: [toward[0] * pull, toward[1] * pull, toward[2] * pull] };
      }
      return { value_m, fix, detail: `nearest surface ${best.toFixed(2)}m vs gap ${gap}m` };
    },
  },
  {
    id: 'presence',
    gate: 'constraints',
    defaultHard: true,
    qualitative: false,
    doc: "A named role must (mode=required) or must not (mode=forbidden) exist within the region. Encodes 'every room needs an air solution / two closures'.",
    params: ['role', 'mode'],
    evaluate: ({ constraint, scene }) => {
      if (!scene || !scene.instances) return SKIP('no scene context');
      const role = str(constraint.params.role);
      const mode = str(constraint.params.mode) === 'forbidden' ? 'forbidden' : 'required';
      if (!role) return SKIP('no role param');
      const found = scene.instances.some(i => i.tags?.['role'] === role);
      const value_m = mode === 'required'
        ? (found ? 1 : -1)
        : (found ? -1 : 1);
      return { value_m, detail: `role "${role}" ${found ? 'present' : 'absent'} (mode=${mode})` };
    },
  },
  {
    id: 'max_straight_run',
    gate: 'collision',
    defaultHard: true,
    qualitative: false,
    doc: "No straight unbroken span longer than max_m along the region/axis. Encodes G-1 sightlines and 'no straight air > 6 m'.",
    params: ['max_m', 'axis'],
    evaluate: () => {
      // Real geometry measurement happens in the C++ PCG node + scene validator.
      // No geometry context is available in the TS evaluator at this stage.
      return SKIP('no geometry context');
    },
  },
];

export function primitivesById(): Map<string, Primitive> {
  const m = new Map<string, Primitive>();
  for (const p of PRIMITIVES) m.set(p.id, p);
  return m;
}

/** Signed distance from point to a convex polygon edge: + inside, - outside. */
export function polygonMargin(poly: [number, number][], pt: [number, number]): number {
  const n = poly.length;
  let inside = true;
  let minEdge = Infinity;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const px = pt[0] - a[0], py = pt[1] - a[1];
    const cross = ex * py - ey * px;          // >0 left of edge (CCW interior)
    const edgeLen = Math.hypot(ex, ey) || 1;
    const distToEdge = Math.abs(cross) / edgeLen;
    minEdge = Math.min(minEdge, distToEdge);
    if (cross < 0) inside = false;
  }
  return inside ? minEdge : -minEdge;
}

/** Convert a ConstraintResult-bound outcome into hard/soft + ok decision.
 *  Qualitative primitives may only hard-gate when their backing field is locked.
 *  Exposed so the evaluator and tests share one rule. */
export function resolveHard(prim: Primitive, constraint: Constraint, locked: boolean): boolean {
  const wantHard = constraint.hard ?? prim.defaultHard;
  if (prim.qualitative && !locked) return false; // unlocked semantics never block
  return wantHard;
}

export type { ConstraintResult };
