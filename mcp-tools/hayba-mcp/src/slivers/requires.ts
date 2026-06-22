// Sliver ↔ PLUMB bridge.
//
// A sliver may declare a `requires` block (SliverRequirement[]). Before its side
// effects commit, the runtime should check that the proposed scene satisfies
// BOTH the sliver's inline requirements AND every PLUMB constraint already bound
// to the affected assets/tags — folded into one Verdict. This is the "this tree
// must have these values when using this sliver" guarantee.
//
// This module owns the union + evaluation (pure, testable). The actual
// "block side_effects unless hard gates pass" wiring lives at the side-effect
// boundary (sliver_run / executor) and needs the post-effect scene snapshot —
// see project_mcp_ux_validation_overhaul memory.

import {
  evaluate, constraintsFor, profileMap, validateConstraint,
  type Constraint, type InstanceState, type Profile, type Verdict, type ValidationError,
} from '../plumb/index.js';
import type { SliverSpec } from './types.js';

/** Turn a spec's inline requirements into evaluable plumb Constraints (ids derived). */
export function requirementsToConstraints(spec: SliverSpec): Constraint[] {
  return (spec.requires ?? []).map((r, i) => ({
    id: `${spec.id}#req${i}`,
    primitive: r.primitive,
    params: r.params ?? {},
    binding: r.binding,
    hard: r.hard,
    note: r.note,
  }));
}

/** Define-time validation of a spec's requires against the closed primitive set. */
export function validateSliverRequires(spec: SliverSpec): ValidationError[] {
  const errs: ValidationError[] = [];
  requirementsToConstraints(spec).forEach((c, i) => {
    for (const e of validateConstraint(c)) {
      errs.push({ field: `requires[${i}].${e.field}`, message: e.message });
    }
  });
  return errs;
}

export interface SliverRequiresOptions {
  /** Override the profile map (defaults to the persisted store). */
  profiles?: Map<string, Profile>;
}

/** Evaluate a sliver's requirements + every library constraint bound to the
 *  affected instances, as a single PLUMB Verdict. */
export function checkSliverRequires(
  spec: SliverSpec,
  instances: InstanceState[],
  opts: SliverRequiresOptions = {},
): Verdict {
  const inline = requirementsToConstraints(spec);

  // Union in library constraints bound to each instance's asset/tag (dedup by id).
  const lib: Constraint[] = [];
  const seen = new Set<string>(inline.map(c => c.id));
  for (const inst of instances) {
    for (const c of constraintsFor(inst.asset, inst.tags)) {
      if (!seen.has(c.id)) { seen.add(c.id); lib.push(c); }
    }
  }

  return evaluate(instances, [...inline, ...lib], { profiles: opts.profiles ?? profileMap() });
}
