// MCP tool handlers for the validator surface.
//
// Five tools:
//   validator_run      → manual evaluation pass
//   validator_history  → read persisted findings (UI primary source of truth)
//   validator_resolve  → mark a finding resolved / unresolved
//   validator_clear    → wipe history
//   validator_rules    → catalog of all known rules + their disabled state

import { z } from 'zod';
import { join } from 'node:path';
import {
  RULES,
  runManual,
  listFindings,
  markResolved,
  clearHistory,
  isRuleDisabled,
  setRuleDisabled,
  type ValidatorContext,
  type ValidatorRule,
} from '../../validator/index.js';
import {
  RULE_CATEGORIES,
  STRICTNESS_MODES,
  clearCategoryStrictness,
  getStrictness,
  getStrictnessConfig,
  meetsStrictness,
  setStrictness,
  type RuleCategory,
  type Strictness,
} from '../../validator/config.js';
import { UI_RULES } from '../../validator/ui/index.js';
import type { UETcpClient } from '../../tcp-client.js';
import { loadConstraints, primitivesById } from '../../plumb/index.js';

export const validatorRunSchema = {
  scope: z.union([
    z.literal('all'),
    z.object({ rule_ids: z.array(z.string()).optional() }),
  ]).optional(),
  persist: z.boolean().optional(),
};

export interface ValidatorRunCtx {
  ue: UETcpClient | null;
  scratchDir: string;
}

export async function validatorRunHandler(
  args: { scope?: 'all' | { rule_ids?: string[] }; persist?: boolean },
  ctx: ValidatorRunCtx,
): Promise<{ findings: ReturnType<typeof toApiFinding>[]; total: number }> {
  const scope: 'all' | { ids?: string[] } =
    args.scope === undefined || args.scope === 'all'
      ? 'all'
      : { ids: args.scope.rule_ids };

  const ctxFactory = (rule: ValidatorRule): ValidatorContext => ({
    toolName: 'validator_run',
    toolArgs: { ruleId: rule.id },
    toolResult: null,
    ue: ctx.ue,
    scratchDir: ctx.scratchDir,
  });

  const findings = await runManual(scope, ctxFactory);
  return { findings: findings.map(toApiFinding), total: findings.length };
}

export const validatorHistorySchema = {
  limit: z.number().int().min(1).max(10_000).optional(),
  since_iso: z.string().optional(),
  include_resolved: z.boolean().optional(),
  rule_ids: z.array(z.string()).optional(),
};

export async function validatorHistoryHandler(args: {
  limit?: number;
  since_iso?: string;
  include_resolved?: boolean;
  rule_ids?: string[];
}): Promise<{ findings: ReturnType<typeof toApiFinding>[] }> {
  const findings = await listFindings({
    limit: args.limit,
    sinceIso: args.since_iso,
    includeResolved: args.include_resolved,
    ruleIds: args.rule_ids,
  });
  return { findings: findings.map(toApiFinding) };
}

export const validatorResolveSchema = {
  timestamp: z.string(),
  resolved: z.boolean(),
};

export async function validatorResolveHandler(args: {
  timestamp: string;
  resolved: boolean;
}): Promise<{ ok: boolean; changed: boolean }> {
  const changed = await markResolved(args.timestamp, args.resolved);
  return { ok: true, changed };
}

export const validatorClearSchema = {
  confirm: z.boolean(),
};

export async function validatorClearHandler(args: { confirm: boolean }): Promise<
  { ok: boolean; removed: number } | { ok: false; error: string }
> {
  if (!args.confirm) {
    return { ok: false, error: 'pass confirm:true to actually clear history' };
  }
  const { removed } = await clearHistory();
  return { ok: true, removed };
}

export const validatorRulesSchema = {
  include_disabled_state: z.boolean().optional(),
};

export interface RuleCatalogEntry {
  id: string;
  severity: ValidatorRule['severity'];
  message: string;
  hint: string;
  refs?: string[];
  trigger: ValidatorRule['trigger'];
  has_evaluator: boolean;
  disabled?: boolean;
  /** Present on rules that declare one (currently the UI ruleset). */
  category?: string;
  min_strictness?: string;
  /** Whether the rule fires at the category's current strictness setting. */
  active?: boolean;
}

export async function validatorRulesHandler(args: { include_disabled_state?: boolean }): Promise<{
  rules: RuleCatalogEntry[];
}> {
  const includeState = args.include_disabled_state !== false;
  // One validator catalog: the advisory "floppy" rules + the active PLUMB
  // constraint checks, listed together.
  const floppy: RuleCatalogEntry[] = RULES.map(r => ({
    id: r.id,
    severity: r.severity,
    message: r.message,
    hint: r.hint,
    refs: r.refs,
    trigger: r.trigger,
    has_evaluator: typeof r.evaluate === 'function',
    ...(includeState ? { disabled: isRuleDisabled(r.id) } : {}),
  }));

  const prims = primitivesById();
  const constraintRules: RuleCatalogEntry[] = loadConstraints().map(c => {
    const prim = prims.get(c.primitive);
    const bind = c.binding.asset ?? (c.binding.tag ? `#${c.binding.tag.axis}=${c.binding.tag.value}` : '?');
    const hard = c.hard ?? prim?.defaultHard ?? false;
    return {
      id: `plumb:${c.id}`,
      severity: (hard ? 'error' : 'warning') as ValidatorRule['severity'],
      message: `PLUMB constraint: ${c.primitive} on ${bind}`,
      hint: c.note ?? prim?.doc ?? 'A bound PLUMB constraint check.',
      refs: c.refs,
      trigger: 'manual' as ValidatorRule['trigger'],
      has_evaluator: true,
      ...(includeState ? { disabled: c.enabled === false } : {}),
    };
  });

  // UI rules are catalogued alongside the rest so one settings surface covers
  // everything. They carry a category and a minimum strictness, which is what
  // the Configure panel needs to show why a rule is or is not currently firing.
  const uiRules: RuleCatalogEntry[] = UI_RULES.map(r => ({
    id: r.id,
    severity: r.severity,
    message: r.title,
    hint: r.needsLayout
      ? 'Needs resolved layout — skipped (and reported as skipped) when the blueprint cannot be laid out.'
      : 'Evaluated from the widget tree alone.',
    trigger: 'manual' as ValidatorRule['trigger'],
    has_evaluator: true,
    category: r.category,
    min_strictness: r.minStrictness,
    active: meetsStrictness(r.minStrictness, getStrictness(r.category)),
    ...(includeState ? { disabled: isRuleDisabled(r.id) } : {}),
  }));

  return { rules: [...floppy, ...constraintRules, ...uiRules] };
}

export const validatorStrictnessSchema = {
  mode: z
    .enum(STRICTNESS_MODES)
    .optional()
    .describe('New strictness. Omit to read the current settings without changing anything.'),
  category: z
    .enum(RULE_CATEGORIES)
    .optional()
    .describe('Set strictness for one category only. Omit to set the global default.'),
  reset_category: z
    .enum(RULE_CATEGORIES)
    .optional()
    .describe('Clear a category override so it follows the global default again.'),
};

export interface StrictnessView {
  default: string;
  by_category: Record<string, string>;
  /** Effective mode for every category, after applying the default. */
  effective: Record<string, string>;
  modes: readonly string[];
  categories: readonly string[];
}

export async function validatorStrictnessHandler(args: {
  mode?: Strictness;
  category?: RuleCategory;
  reset_category?: RuleCategory;
}): Promise<StrictnessView> {
  if (args.reset_category) clearCategoryStrictness(args.reset_category);
  if (args.mode) setStrictness(args.mode, args.category);

  const config = getStrictnessConfig();
  const effective: Record<string, string> = {};
  for (const c of RULE_CATEGORIES) effective[c] = getStrictness(c);

  return {
    default: config.default,
    by_category: { ...config.byCategory },
    effective,
    modes: STRICTNESS_MODES,
    categories: RULE_CATEGORIES,
  };
}

export const validatorSetRuleEnabledSchema = {
  rule_id: z.string(),
  enabled: z.boolean(),
};

export async function validatorSetRuleEnabledHandler(args: { rule_id: string; enabled: boolean }): Promise<{ ok: boolean }> {
  setRuleDisabled(args.rule_id, !args.enabled);
  return { ok: true };
}

function toApiFinding(f: import('../../validator/index.js').ValidatorFinding) {
  return {
    rule_id: f.ruleId,
    severity: f.severity,
    message: f.message,
    hint: f.hint,
    refs: f.refs,
    context: f.context,
    timestamp: f.timestamp,
    tool_name: f.toolName,
    resolved: f.resolved ?? false,
    resolved_at: f.resolvedAt,
  };
}

export function defaultScratchDir(projectDir?: string): string {
  return join(projectDir ?? process.cwd(), '.scratch');
}
