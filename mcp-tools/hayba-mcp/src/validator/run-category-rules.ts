// One rule-running loop, shared by every rule category.
//
// The UI and content validators had line-for-line copies of this: select rules,
// drop the disabled ones, drop the ones below the configured strictness, report
// (never silently pass) the ones whose input data is absent, evaluate the rest
// with a throw-guard, sort by severity then id, and count.
//
// Duplicating it meant the honesty property — "a rule that checked nothing is
// reported as skipped, not as passing" — had to be re-implemented correctly in
// every new category. It is now implemented once, and a category supplies only
// the part that genuinely differs: what counts as having nothing to check.

import { isRuleDisabled, meetsStrictness, type Strictness, type RuleCategory } from './config.js';
import { compareFindings, countBySeverity, type Finding, type Severity } from './finding.js';

export type RuleSeverity = Severity;

/** The part of a category rule this runner needs. Categories add their own
 *  fields (needsLayout, needs, title, …) and read them in `hasNothingToCheck`. */
export interface RunnableRule<Ctx> {
  id: string;
  category: RuleCategory;
  minStrictness: Strictness;
  evaluate: (ctx: Ctx) => Finding[];
}

export interface RuleRunOutcome {
  /** Sorted by severity, then rule id. */
  findings: Finding[];
  /** How many rules actually ran. Never inflated by skips. */
  evaluated: number;
  /** Ran nothing because their input data was absent. */
  skipped: string[];
  /** Ran nothing because the user turned them off. */
  disabled: string[];
  /** Ran nothing because they sit above the configured strictness. */
  belowStrictness: string[];
  counts: Record<Severity, number>;
}

export interface RuleRunInput<Ctx, R extends RunnableRule<Ctx>> {
  /** The full catalogue for this category. */
  rules: readonly R[];
  /** Same catalogue, indexed — used only when `ruleIds` narrows the run. */
  byId: Map<string, R>;
  /** Restrict the run to these ids. Unknown ids are ignored. */
  ruleIds?: string[];
  ctx: Ctx;
  strictness: Strictness;
  /**
   * True when this rule's input data is missing from the snapshot. Such a rule
   * is reported in `skipped` — a geometry rule with no geometry has checked
   * nothing, and reporting it as passing would be a lie.
   */
  hasNothingToCheck: (rule: R) => boolean;
}

export function runCategoryRules<Ctx, R extends RunnableRule<Ctx>>(
  input: RuleRunInput<Ctx, R>,
): RuleRunOutcome {
  const { ctx, strictness, hasNothingToCheck } = input;

  const selected = input.ruleIds
    ? input.ruleIds.map((id) => input.byId.get(id)).filter((r): r is R => r !== undefined)
    : input.rules;

  const findings: Finding[] = [];
  const skipped: string[] = [];
  const disabled: string[] = [];
  const belowStrictness: string[] = [];
  let evaluated = 0;

  for (const rule of selected) {
    if (isRuleDisabled(rule.id)) {
      disabled.push(rule.id);
      continue;
    }
    if (!meetsStrictness(rule.minStrictness, strictness)) {
      belowStrictness.push(rule.id);
      continue;
    }
    if (hasNothingToCheck(rule)) {
      skipped.push(rule.id);
      continue;
    }

    evaluated++;
    try {
      findings.push(...rule.evaluate(ctx));
    } catch (e) {
      // A thrown rule is surfaced as info rather than failing the whole run:
      // one broken rule must not cost the caller every other finding.
      findings.push({
        ruleId: rule.id,
        category: rule.category,
        severity: 'info',
        message: `Rule "${rule.id}" threw while evaluating and was skipped.`,
        hint: e instanceof Error ? e.message : String(e),
      });
    }
  }

  findings.sort(compareFindings);

  return {
    findings, evaluated, skipped, disabled, belowStrictness,
    counts: countBySeverity(findings),
  };
}
