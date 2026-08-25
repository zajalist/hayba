// The one verdict shape.
//
// Five of these had accumulated -- ValidatorFinding, UiFinding, ContentFinding,
// BaseFinding and PLUMB's ConstraintResult -- and a tool that wanted to report
// on two categories had to hand-convert between them (see tools/plumb/tools.ts).
// BaseFinding was itself an earlier attempt to unify UiFinding and
// ContentFinding, and it replaced neither: it was added alongside them. That is
// the failure mode this file exists to avoid, so the adapters below are
// deliberately temporary. Each one is deleted in the same commit that migrates
// its producers to emit `Finding` directly (see ADR-0009).
//
// The shape is PLUMB's: a finding says how far off the thing is and which way
// to move it, not merely that something is wrong. Where a check genuinely has
// no measurable quantity -- "this asset path does not exist" -- `measurement`
// is absent rather than faked with a 0 or a 1.

import type { FixVector, ConstraintResult } from '../plumb/contracts.js';
import type { RuleCategory } from './config.js';

export type Severity = 'error' | 'warning' | 'info';

/** The units a finding can be measured in. Deliberately closed: a check that
 *  needs a new unit is a design conversation, not a new string. */
export type Unit = 'm' | 'px' | 'kb' | 'tris' | 'count' | 'ratio';

/** What the check actually measured. `value` is the SIGNED margin in `unit`:
 *  >= 0 means satisfied, and the magnitude is how far past the threshold the
 *  subject sits. Signing it is what lets a caller say "12cm too low" rather
 *  than "fails minimum height". */
export interface Measurement {
  value: number;
  unit: Unit;
  /** Human rendering of the maths, e.g. "62cm < 90cm". */
  detail?: string;
  /** Spatial checks only: how to move the subject to satisfy the constraint. */
  fix?: FixVector;
}

export interface Finding {
  ruleId: string;
  category: RuleCategory;
  severity: Severity;
  message: string;
  hint: string;
  /** What the finding is about -- a widget name, an asset path, an actor
   *  label. Absent when the finding is about the call rather than a thing. */
  subject?: string;
  measurement?: Measurement;
  /** The numbers behind the message, so a caller can re-check the maths. */
  data?: Record<string, unknown>;
  /** Documentation or source anchors supporting the rule. */
  refs?: string[];

  // ── Set only once a finding is persisted (see history.ts) ────────────────
  /** ISO8601; doubles as the stable record id for resolve/clear. */
  timestamp?: string;
  /** The tool call that produced it. */
  toolName?: string;
  resolved?: boolean;
  resolvedAt?: string;
}

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Sort by severity, then rule id -- the order every category already used. */
export function compareFindings(a: Finding, b: Finding): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  return bySeverity !== 0 ? bySeverity : a.ruleId.localeCompare(b.ruleId);
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

// ── Adapters (temporary; each dies with its producer's migration) ───────────

/** PLUMB is the only producer that already speaks in signed margins, so this
 *  adapter is the only one that fills `measurement`. A hard constraint is an
 *  error because the gate refuses to commit on it; a soft one is a warning
 *  because it only feeds the repair objective. */
export function fromConstraintResult(
  c: ConstraintResult,
  opts: { category?: RuleCategory; subject?: string; hint?: string } = {},
): Finding {
  return {
    ruleId: c.name || c.primitive,
    category: opts.category ?? 'general',
    severity: c.hard ? 'error' : 'warning',
    message: c.detail ?? `${c.primitive} violated by ${c.magnitude}m`,
    hint: opts.hint ?? 'Apply the fix vector, or relax the constraint if the intent changed.',
    subject: opts.subject,
    measurement: { value: c.value_m, unit: 'm', detail: c.detail, fix: c.fix },
    data: { primitive: c.primitive, hard: c.hard, magnitude: c.magnitude, confidence: c.confidence, locked: c.locked },
  };
}
