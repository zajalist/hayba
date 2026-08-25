// Content validation entry point. Mirrors the UI validator's contract: rules
// whose data is absent are reported as SKIPPED, never as passing.

import { getStrictness, type Strictness } from '../config.js';
import { runCategoryRules } from '../run-category-rules.js';
import { CONTENT_RULES, contentRulesById, resolveContentThresholds } from './rules.js';
import type {
  // ContentFinding is gone: content rules emit the shared Finding.
  ContentRuleContext,
  ContentSeverity,
  ContentSnapshot,
  ContentValidationResult,
} from './types.js';

export * from './types.js';
export { CONTENT_RULES, contentRulesById, resolveContentThresholds } from './rules.js';

const SEVERITY_ORDER: Record<ContentSeverity, number> = { error: 0, warning: 1, info: 2 };

export interface ContentValidationOptions {
  strictness?: Strictness;
  ruleIds?: string[];
}

export function validateContentSnapshot(
  snapshot: ContentSnapshot,
  options: ContentValidationOptions = {},
): ContentValidationResult {
  const strictness = options.strictness ?? getStrictness('asset');
  const ctx: ContentRuleContext = {
    snapshot,
    strictness,
    thresholds: resolveContentThresholds(strictness),
  };

  const hasTextures = Array.isArray(snapshot.textures);
  const hasMeshes = Array.isArray(snapshot.meshes);

  const outcome = runCategoryRules({
    rules: CONTENT_RULES,
    byId: contentRulesById(),
    ruleIds: options.ruleIds,
    ctx,
    strictness,
    // The audit was not run for this asset type, so the rule checked nothing.
    // Saying so is the difference between "clean" and "not looked at".
    hasNothingToCheck: (rule) =>
      (rule.needs === 'textures' && !hasTextures) || (rule.needs === 'meshes' && !hasMeshes),
  });

  const texturesReported = snapshot.textures?.length ?? 0;
  const meshesReported = snapshot.meshes?.length ?? 0;
  // The audits return only the heaviest N rows. An asset outside that window was
  // never judged, so a clean result must not be read as "the project is clean".
  const truncated =
    (snapshot.textures_scanned !== undefined && snapshot.textures_scanned > texturesReported) ||
    (snapshot.meshes_scanned !== undefined && snapshot.meshes_scanned > meshesReported);

  return {
    strictness,
    findings: outcome.findings,
    rules_evaluated: outcome.evaluated,
    rules_skipped_no_data: outcome.skipped,
    rules_disabled: outcome.disabled,
    rules_below_strictness: outcome.belowStrictness,
    counts: outcome.counts,
    coverage: {
      textures_reported: texturesReported,
      textures_scanned: snapshot.textures_scanned,
      meshes_reported: meshesReported,
      meshes_scanned: snapshot.meshes_scanned,
      truncated,
    },
  };
}
