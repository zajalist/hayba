// Content validation entry point. Mirrors the UI validator's contract: rules
// whose data is absent are reported as SKIPPED, never as passing.

import { getStrictness, isRuleDisabled, meetsStrictness, type Strictness } from '../config.js';
import { CONTENT_RULES, contentRulesById, resolveContentThresholds } from './rules.js';
import type {
  ContentFinding,
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

  const byId = contentRulesById();
  const selected = options.ruleIds
    ? options.ruleIds.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => r !== undefined)
    : CONTENT_RULES;

  const findings: ContentFinding[] = [];
  const skipped: string[] = [];
  const disabled: string[] = [];
  const belowStrictness: string[] = [];
  let evaluated = 0;

  const hasTextures = Array.isArray(snapshot.textures);
  const hasMeshes = Array.isArray(snapshot.meshes);

  for (const rule of selected) {
    if (isRuleDisabled(rule.id)) {
      disabled.push(rule.id);
      continue;
    }
    if (!meetsStrictness(rule.minStrictness, strictness)) {
      belowStrictness.push(rule.id);
      continue;
    }
    // The audit was not run for this asset type, so the rule checked nothing.
    // Saying so is the difference between "clean" and "not looked at".
    if ((rule.needs === 'textures' && !hasTextures) || (rule.needs === 'meshes' && !hasMeshes)) {
      skipped.push(rule.id);
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
    return bySeverity !== 0 ? bySeverity : a.ruleId.localeCompare(b.ruleId);
  });

  const counts: Record<ContentSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  const texturesReported = snapshot.textures?.length ?? 0;
  const meshesReported = snapshot.meshes?.length ?? 0;
  // The audits return only the heaviest N rows. An asset outside that window was
  // never judged, so a clean result must not be read as "the project is clean".
  const truncated =
    (snapshot.textures_scanned !== undefined && snapshot.textures_scanned > texturesReported) ||
    (snapshot.meshes_scanned !== undefined && snapshot.meshes_scanned > meshesReported);

  return {
    strictness,
    findings,
    rules_evaluated: evaluated,
    rules_skipped_no_data: skipped,
    rules_disabled: disabled,
    rules_below_strictness: belowStrictness,
    counts,
    coverage: {
      textures_reported: texturesReported,
      textures_scanned: snapshot.textures_scanned,
      meshes_reported: meshesReported,
      meshes_scanned: snapshot.meshes_scanned,
      truncated,
    },
  };
}
