// UI validation entry point.
//
// Runs the catalogue over a snapshot, honouring the disable list and the
// category's strictness setting, and reports what it did NOT check as
// explicitly as what it did.

import { getStrictness, isRuleDisabled, meetsStrictness, type Strictness } from '../config.js';
import { UI_RULES, uiRulesById } from './rules.js';
import { resolveThresholds } from './thresholds.js';
import type {
  UiFinding,
  UiPlatform,
  UiRuleContext,
  UiSeverity,
  UiSnapshot,
  UiValidationResult,
  UiWidget,
} from './types.js';

export * from './types.js';
export { UI_RULES, uiRulesById } from './rules.js';
export { resolveThresholds, contrastRatio, relativeLuminance } from './thresholds.js';

const SEVERITY_ORDER: Record<UiSeverity, number> = { error: 0, warning: 1, info: 2 };

export interface UiValidationOptions {
  platform?: UiPlatform;
  /** Overrides the configured strictness for this run only. */
  strictness?: Strictness;
  /** Restrict the run to these rule ids. */
  ruleIds?: string[];
}

function buildContext(
  snapshot: UiSnapshot,
  platform: UiPlatform,
  strictness: Strictness,
): UiRuleContext {
  const byName = new Map<string, UiWidget>();
  for (const w of snapshot.widgets) byName.set(w.name, w);

  const childrenOf = new Map<string, UiWidget[]>();
  for (const w of snapshot.widgets) {
    if (!w.parent) continue;
    const list = childrenOf.get(w.parent);
    if (list) list.push(w);
    else childrenOf.set(w.parent, [w]);
  }

  return {
    snapshot,
    platform,
    strictness,
    thresholds: resolveThresholds(platform, strictness, snapshot.screen_height),
    byName,
    childrenOf,
  };
}

export function validateUiSnapshot(
  snapshot: UiSnapshot,
  options: UiValidationOptions = {},
): UiValidationResult {
  const platform = options.platform ?? 'pc';
  const strictness = options.strictness ?? getStrictness('ui');
  const ctx = buildContext(snapshot, platform, strictness);

  const byId = uiRulesById();
  const selected = options.ruleIds
    ? options.ruleIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined)
    : UI_RULES;

  const findings: UiFinding[] = [];
  const skippedNoLayout: string[] = [];
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
    if (rule.needsLayout && !snapshot.layout_resolved) {
      // Reported, not silently passed. A geometry rule with no geometry has
      // checked nothing, and saying otherwise would be the same lie the old
      // slot-props path told.
      skippedNoLayout.push(rule.id);
      continue;
    }

    evaluated++;
    try {
      findings.push(...rule.evaluate(ctx));
    } catch (e) {
      findings.push({
        ruleId: rule.id,
        category: rule.category,
        severity: 'info',
        message: `Rule "${rule.id}" threw while evaluating and was skipped.`,
        hint: e instanceof Error ? e.message : String(e),
      });
    }
  }

  findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.ruleId.localeCompare(b.ruleId);
  });

  const counts: Record<UiSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    widget_blueprint_path: snapshot.widget_blueprint_path,
    platform,
    strictness,
    layout_resolved: snapshot.layout_resolved,
    layout_error: snapshot.layout_error,
    findings,
    rules_evaluated: evaluated,
    rules_skipped_no_layout: skippedNoLayout,
    rules_disabled: disabled,
    rules_below_strictness: belowStrictness,
    counts,
  };
}
