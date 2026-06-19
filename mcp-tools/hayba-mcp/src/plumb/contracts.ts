// PLUMB contract port — the frozen seam.
//
// Mirrors D:/Hackathons/plumb/contracts.py (Verdict / GateResult /
// ConstraintResult / FixVector / Transform / PAP) so the hayba validator can
// speak PLUMB's quantified, *directional* language: every check yields a signed
// value_m plus a FixVector telling the agent which way to move, instead of the
// boolean severity findings the legacy validator emits.
//
// Canonical space: Z-up, right-handed, metres, kilograms (same as PLUMB).
//
// On top of the frozen seam this file adds the hayba-only *constraint language*
// types (Constraint / Profile / InstanceState). The language is deliberately
// tiny: a CLOSED set of primitives (see primitives.ts). Authoring fills values;
// it never writes logic. Generality comes from BINDING (asset path or tag), not
// from a growing grammar — see project_mcp_ux_validation_overhaul memory.

export const PLUMB_SCHEMA_VERSION = '0.1.0';

// ── Geometry primitives ──────────────────────────────────────────────────────

/** Z-up, right-handed, metres. quat is [x,y,z,w]. */
export interface Transform {
  pos: [number, number, number];
  quat: [number, number, number, number];
  scale: [number, number, number];
}

export function identityTransform(): Transform {
  return { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] };
}

/** How to move an object to satisfy a violated constraint. */
export interface FixVector {
  translate: [number, number, number];
  rotate_quat?: [number, number, number, number];
}

// ── Verdict seam (frozen — matches contracts.py field-for-field) ─────────────

export type GateName = 'collision' | 'stability' | 'constraints' | 'reach';

/** Gate evaluation order = hard-fail short-circuit order. */
export const GATE_ORDER: GateName[] = ['collision', 'stability', 'constraints', 'reach'];

/** One constraint's result. magnitude is the unsigned violation amount
 *  (0 = satisfied); value_m is the *signed* measured margin (>=0 = ok). */
export interface ConstraintResult {
  name: string;          // constraint id ("" for anonymous/sliver-inline)
  primitive: string;     // which primitive produced it
  ok: boolean;
  hard: boolean;         // hard → gates commit; soft → repair objective only
  magnitude: number;     // violation magnitude (metres or normalised), 0 = ok
  value_m: number;       // signed margin; the raw measured quantity
  fix?: FixVector;
  detail?: string;       // human string, e.g. "62cm < 90cm"
  confidence?: number;   // qualitative primitives only (0..1)
  locked?: boolean;      // qualitative: human-locked → may hard-gate
}

export interface GateResult {
  gate: GateName;
  ok: boolean | null;    // null when skipped (no constraints in this gate)
  skipped: boolean;
  value_m: number | null;
  fix?: FixVector;
  viz?: string;          // viewport viz hint, e.g. "com_outside_polygon"
  detail?: string;
  constraints: ConstraintResult[];
}

export interface Verdict {
  schema_version: string;
  ok: boolean;
  stopped_at: GateName | null;  // first hard-failed gate, null if all clear
  gates: GateResult[];
  soft_cost: number;            // Σ magnitude of failed soft constraints
}

// ── Profile (PAP) — baked, reusable per asset ────────────────────────────────
//
// Splits DETERMINISTIC geometry/physics (baked free from UE bounds + collision)
// from QUALITATIVE semantics (AI-generated affordances/regions, confidence-
// tagged, human-editable + lockable via provenance).

export interface AABB { min: [number, number, number]; max: [number, number, number]; }

export interface Geometry {
  aabb: AABB;
  obb?: { center: [number, number, number]; extents: [number, number, number]; quat: [number, number, number, number] };
  volume_m3?: number;
}

/** A named, local-space region the asset affords (door swing, seat, etc.). */
export interface Affordance {
  id: string;
  region?: { center: [number, number, number]; extents: [number, number, number] };
  detail?: string;
}

export interface ProfileSemantics {
  cls?: string;
  up: [number, number, number];     // local up, default world-up
  front: [number, number, number];  // local front, default +X
  affordances: Affordance[];
}

export interface ProfilePhysical {
  mass_kg?: number;
  com?: [number, number, number];   // local-space centre of mass
}

export interface ProfileStructural {
  /** Convex hull of the base contact points, local XY. */
  support_footprint?: [number, number][];
  /** z of the base relative to the pivot, metres. Negative when the pivot sits
   *  above the visible base (e.g. SM_GiantTree_01 = -3.8m). Drives `grounded`. */
  ground_offset_m?: number;
}

export interface Provenance {
  auto: boolean;          // baked vs hand-authored
  edited_fields: string[];
  locked: string[];       // dotted field paths the human locked
}

/** Physical Asset Profile. */
export interface Profile {
  asset_id: string;       // /Game/... path
  bake_version: number;
  profile: string;        // archetype, e.g. "rigid_prop"
  geometry: Geometry;
  semantics: ProfileSemantics;
  physical: ProfilePhysical;
  structural: ProfileStructural;
  rest_states: string[];
  regions: Array<Record<string, unknown>>;
  provenance: Provenance;
  baked_at: string;       // ISO8601
}

// ── Constraint language (hayba-only) ─────────────────────────────────────────

/** Binds a constraint to an asset path OR an architecture tag axis/value.
 *  Author once per class; every matching instance inherits it (lesson enforced,
 *  not remembered). Exactly one of asset/tag should be set. */
export interface ConstraintBinding {
  asset?: string;
  tag?: { axis: string; value: string };
}

export interface Constraint {
  id: string;
  primitive: string;                  // must key into PRIMITIVES
  params: Record<string, unknown>;
  binding: ConstraintBinding;
  hard?: boolean;                     // override primitive default
  note?: string;
  refs?: string[];
  enabled?: boolean;                  // default true
}

/** A live instance to validate. */
export interface InstanceState {
  object: string;                     // actor label / node id
  asset?: string;                     // resolved asset path (binding match)
  tags?: Record<string, string>;      // axis → value (binding match)
  transform: Transform;
}

export interface SceneContext {
  instances: InstanceState[];         // every instance (clearance/proximity/count)
}
