// UI validation entry point.
//
// Runs the catalogue over a snapshot, honouring the disable list and the
// category's strictness setting, and reports what it did NOT check as
// explicitly as what it did.

import { getStrictness, type Strictness } from '../config.js';
import { runCategoryRules } from '../run-category-rules.js';
import { UI_RULES, uiRulesById } from './rules.js';
import { resolveThresholds } from './thresholds.js';
import type {
  // UiFinding is gone: UI rules emit the shared Finding.
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

  const outcome = runCategoryRules({
    rules: UI_RULES,
    byId: uiRulesById(),
    ruleIds: options.ruleIds,
    ctx,
    strictness,
    // A geometry rule with no geometry has checked nothing, and saying
    // otherwise would be the same lie the old slot-props path told.
    hasNothingToCheck: (rule) => rule.needsLayout && !snapshot.layout_resolved,
  });

  return {
    widget_blueprint_path: snapshot.widget_blueprint_path,
    platform,
    strictness,
    layout_resolved: snapshot.layout_resolved,
    layout_error: snapshot.layout_error,
    findings: outcome.findings,
    rules_evaluated: outcome.evaluated,
    rules_skipped_no_layout: outcome.skipped,
    rules_disabled: outcome.disabled,
    rules_below_strictness: outcome.belowStrictness,
    counts: outcome.counts,
  };
}
