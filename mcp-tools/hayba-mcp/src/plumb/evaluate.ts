// Verdict assembly — runs bound constraints against instances and folds the
// per-constraint outcomes into PLUMB's gated, directional Verdict.
//
// Gate order (collision → stability → constraints → reach) is the hard-fail
// short-circuit order: the first gate with a failing HARD constraint sets
// `stopped_at` and gates the commit. Soft failures never block — they sum into
// `soft_cost` as a repair objective. Skipped constraints (missing profile /
// no matching scene targets) are neither ok nor failing — they're dropped.

import {
  GATE_ORDER, PLUMB_SCHEMA_VERSION,
  type Constraint, type ConstraintResult, type GateName, type GateResult,
  type InstanceState, type Profile, type SceneContext, type Verdict,
} from './contracts.js';
import { primitivesById, resolveHard, type Primitive } from './primitives.js';

export interface EvaluateOptions {
  /** Asset path → baked profile. Missing → primitives needing one self-skip. */
  profiles?: Map<string, Profile>;
}

/** True when a constraint's binding selects this instance. */
export function bindingMatches(c: Constraint, inst: InstanceState): boolean {
  if (c.binding.asset) return inst.asset === c.binding.asset;
  if (c.binding.tag) return inst.tags?.[c.binding.tag.axis] === c.binding.tag.value;
  return false;
}

/** Evaluate one constraint against one instance. Returns null when skipped. */
export function evalConstraint(
  c: Constraint,
  inst: InstanceState,
  scene: SceneContext,
  profile: Profile | null,
  prim: Primitive,
): ConstraintResult | null {
  const out = prim.evaluate({ constraint: c, instance: inst, profile, scene });
  if (out.skip) return null;
  const locked = prim.qualitative && isFieldLocked(prim, c, profile);
  const hard = resolveHard(prim, c, locked);
  const ok = out.value_m >= 0;
  return {
    name: c.id,
    primitive: prim.id,
    ok,
    hard,
    magnitude: ok ? 0 : -out.value_m,
    value_m: out.value_m,
    fix: out.fix,
    detail: out.detail,
    confidence: out.confidence,
    locked,
  };
}

function isFieldLocked(prim: Primitive, c: Constraint, profile: Profile | null): boolean {
  const locked = profile?.provenance?.locked ?? [];
  if (prim.id === 'facing') return locked.includes('semantics.front');
  if (prim.id === 'affordance_clear') return locked.includes(`affordance:${c.params.affordance}`);
  return false;
}

/** Run every applicable constraint over every instance and build one Verdict. */
export function evaluate(
  instances: InstanceState[],
  constraints: Constraint[],
  opts: EvaluateOptions = {},
): Verdict {
  const scene: SceneContext = { instances };
  const prims = primitivesById();
  const profiles = opts.profiles ?? new Map<string, Profile>();
  const active = constraints.filter(c => c.enabled !== false);

  const results: ConstraintResult[] = [];
  for (const inst of instances) {
    const profile = inst.asset ? (profiles.get(inst.asset) ?? null) : null;
    for (const c of active) {
      if (!bindingMatches(c, inst)) continue;
      const prim = prims.get(c.primitive);
      if (!prim) continue; // unknown primitive — define-time validation rejects these
      const r = evalConstraint(c, inst, scene, profile, prim);
      if (r) results.push({ ...r, name: `${c.id}@${inst.object}` });
    }
  }

  return assembleVerdict(results, prims);
}

/** Fold per-constraint results into the gated Verdict. Exposed for sliver use. */
export function assembleVerdict(
  results: ConstraintResult[],
  prims = primitivesById(),
): Verdict {
  const byGate = new Map<GateName, ConstraintResult[]>();
  for (const r of results) {
    const gate = prims.get(r.primitive)?.gate ?? 'constraints';
    (byGate.get(gate) ?? byGate.set(gate, []).get(gate)!).push(r);
  }

  const gates: GateResult[] = [];
  let stopped_at: GateName | null = null;
  let soft_cost = 0;

  for (const gate of GATE_ORDER) {
    const rs = byGate.get(gate);
    if (!rs || rs.length === 0) {
      gates.push({ gate, ok: null, skipped: true, value_m: null, constraints: [] });
      continue;
    }
    const hardFails = rs.filter(r => !r.ok && r.hard);
    const softFails = rs.filter(r => !r.ok && !r.hard);
    soft_cost += softFails.reduce((s, r) => s + r.magnitude, 0);

    // worst (most-violated) constraint drives the gate-level value/fix/viz
    const worst = rs.reduce((a, b) => (b.value_m < a.value_m ? b : a));
    const ok = hardFails.length === 0;
    gates.push({
      gate,
      ok,
      skipped: false,
      value_m: worst.value_m,
      fix: worst.value_m < 0 ? worst.fix : undefined,
      detail: worst.detail,
      constraints: rs,
    });
    if (!ok && stopped_at === null) stopped_at = gate;
  }

  return {
    schema_version: PLUMB_SCHEMA_VERSION,
    ok: stopped_at === null,
    stopped_at,
    gates,
    soft_cost: Number(soft_cost.toFixed(6)),
  };
}
