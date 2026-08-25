// Validator runtime — evaluates rules and persists findings to history.
//
// Two entry points:
//   - runAfterTool: post-condition pass triggered by tool wrappers.
//   - runManual:    user-driven pass triggered by validator_run MCP tool.

import { RULES, rulesForTool, rulesById, type ValidatorContext, type ValidatorRule } from './rules.js';
import type { FindingRecord } from './history.js';
import type { RuleFinding } from './rules.js';
import { appendFinding } from './history.js';
import { isRuleDisabled } from './config.js';

export type { ValidatorContext } from './rules.js';
export type { FindingRecord } from './history.js';

function nowIso(): string {
  return new Date().toISOString();
}

/** Evaluate every rule registered to trigger after `ctx.toolName`. Persists
 *  each non-null finding to history before returning. */
export async function runAfterTool(ctx: ValidatorContext): Promise<FindingRecord[]> {
  const rules = rulesForTool(ctx.toolName);
  const findings: FindingRecord[] = [];
  for (const rule of rules) {
    if (isRuleDisabled(rule.id)) continue;
    if (!rule.evaluate) continue;
    let f: RuleFinding | null = null;
    try {
      f = await rule.evaluate(ctx);
    } catch (e) {
      // Rule evaluator threw — record as info so the user can see something
      // went wrong, but don't fail the parent tool call.
      f = {
        ruleId: rule.id,
        category: rule.category,
        severity: 'info',
        message: `validator: rule "${rule.id}" evaluator threw`,
        hint: e instanceof Error ? e.message : String(e),
        timestamp: nowIso(),
        toolName: ctx.toolName,
      };
    }
    if (f) {
      // Normalise fields the evaluator might omit.
      const normalised: FindingRecord = {
        ...f,
        category: f.category ?? rule.category,
        timestamp: f.timestamp || nowIso(),
        toolName: f.toolName || ctx.toolName,
      };
      findings.push(normalised);
      await appendFinding(normalised);
    }
  }
  return findings;
}

export interface ManualRunScope {
  ids?: string[];
}

/** Run a subset of rules in "manual" mode. Most catalog-only rules have no
 *  evaluator, so calling them returns nothing — manual mode is for the user
 *  to ask "re-check rule X" from the Validator panel. */
export async function runManual(
  scope: ManualRunScope | 'all',
  ctxFactory: (rule: ValidatorRule) => ValidatorContext,
): Promise<FindingRecord[]> {
  const byId = rulesById();
  const wanted: ValidatorRule[] = [];
  if (scope === 'all') {
    for (const r of RULES) wanted.push(r);
  } else {
    for (const id of scope.ids ?? []) {
      const r = byId.get(id);
      if (r) wanted.push(r);
    }
  }

  const findings: FindingRecord[] = [];
  for (const rule of wanted) {
    if (isRuleDisabled(rule.id)) continue;
    if (!rule.evaluate) continue;
    const ctx = ctxFactory(rule);
    try {
      const f = await rule.evaluate(ctx);
      if (f) {
        const normalised: FindingRecord = {
          ...f,
          category: f.category ?? rule.category,
          timestamp: f.timestamp || nowIso(),
          toolName: f.toolName || ctx.toolName,
        };
        findings.push(normalised);
        await appendFinding(normalised);
      }
    } catch (e) {
      const f: FindingRecord = {
        ruleId: rule.id,
        category: rule.category,
        severity: 'info',
        message: `validator: rule "${rule.id}" evaluator threw`,
        hint: e instanceof Error ? e.message : String(e),
        timestamp: nowIso(),
        toolName: 'validator_run',
      };
      findings.push(f);
      await appendFinding(f);
    }
  }
  return findings;
}

/** Build a one-shot finding outside the evaluator flow (used by tool wrappers
 *  that need to emit a pre-flight rejection). The finding is persisted to
 *  history just like an after-tool finding. */
export async function emitDirectFinding(
  partial: Omit<FindingRecord, 'timestamp'> & { timestamp?: string },
): Promise<FindingRecord> {
  const f: FindingRecord = { ...partial, timestamp: partial.timestamp ?? nowIso() };
  await appendFinding(f);
  return f;
}
