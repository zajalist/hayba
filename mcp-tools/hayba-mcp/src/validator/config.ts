// Validator configuration: per-rule enable/disable plus per-category strictness.
//
// Persisted to JSON so the UE plugin's Configure panel can change settings
// without round-tripping through MCP. Schema:
//   { "disabled": ["rule_id", ...],
//     "strictness": { "default": "standard", "byCategory": { "ui": "strict" } } }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** How eagerly the validator speaks up.
 *  - relaxed:  only things that are outright broken or will visibly ship wrong.
 *  - standard: the above plus established UI conventions (the default).
 *  - strict:   the above plus house-style and polish nits.
 *  A rule declares the LOWEST mode at which it fires, so raising strictness only
 *  ever adds findings — it never silences one. */
export const STRICTNESS_MODES = ['relaxed', 'standard', 'strict'] as const;
export type Strictness = (typeof STRICTNESS_MODES)[number];

const STRICTNESS_RANK: Record<Strictness, number> = { relaxed: 0, standard: 1, strict: 2 };

/** Domains a rule can belong to. Strictness is set per category so a team can
 *  run UI checks strictly while keeping PCG advisory. */
export const RULE_CATEGORIES = [
  'ui',
  'pcg',
  'landscape',
  'material',
  'blueprint',
  'python',
  'asset',
  'general',
] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

export const DEFAULT_STRICTNESS: Strictness = 'standard';

let CONFIG_PATH_OVERRIDE: string | null = null;

function defaultConfigPath(): string {
  const env = process.env.HAYBA_VALIDATOR_CONFIG;
  if (env) return env;
  return join(process.cwd(), '.scratch', 'validator-config.json');
}

export function setConfigPath(p: string | null): void {
  CONFIG_PATH_OVERRIDE = p;
}

function getConfigPath(): string {
  return CONFIG_PATH_OVERRIDE ?? defaultConfigPath();
}

export interface StrictnessConfig {
  default: Strictness;
  byCategory: Partial<Record<RuleCategory, Strictness>>;
}

interface ValidatorConfig {
  disabled: string[];
  strictness: StrictnessConfig;
}

function isStrictness(v: unknown): v is Strictness {
  return typeof v === 'string' && (STRICTNESS_MODES as readonly string[]).includes(v);
}

function isCategory(v: unknown): v is RuleCategory {
  return typeof v === 'string' && (RULE_CATEGORIES as readonly string[]).includes(v);
}

function emptyConfig(): ValidatorConfig {
  return { disabled: [], strictness: { default: DEFAULT_STRICTNESS, byCategory: {} } };
}

function loadConfig(): ValidatorConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return emptyConfig();
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ValidatorConfig>;
    const config = emptyConfig();

    if (Array.isArray(parsed.disabled)) {
      config.disabled = parsed.disabled.filter((x): x is string => typeof x === 'string');
    }

    // Unknown or malformed values fall back to the default rather than throwing:
    // a hand-edited settings file should never take the validator offline.
    const s = parsed.strictness;
    if (s && typeof s === 'object') {
      if (isStrictness(s.default)) config.strictness.default = s.default;
      if (s.byCategory && typeof s.byCategory === 'object') {
        for (const [key, value] of Object.entries(s.byCategory)) {
          if (isCategory(key) && isStrictness(value)) config.strictness.byCategory[key] = value;
        }
      }
    }
    return config;
  } catch {
    return emptyConfig();
  }
}

function saveConfig(c: ValidatorConfig): void {
  const path = getConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(c, null, 2), 'utf-8');
}

export function isRuleDisabled(id: string): boolean {
  return loadConfig().disabled.includes(id);
}

export function setRuleDisabled(id: string, disabled: boolean): void {
  const c = loadConfig();
  const has = c.disabled.includes(id);
  if (disabled && !has) c.disabled.push(id);
  if (!disabled && has) c.disabled = c.disabled.filter((x) => x !== id);
  saveConfig(c);
}

export function listDisabledRules(): string[] {
  return loadConfig().disabled.slice();
}

/** Effective strictness for a category: its own setting, else the global default. */
export function getStrictness(category?: RuleCategory): Strictness {
  const c = loadConfig().strictness;
  if (category) {
    const override = c.byCategory[category];
    if (override) return override;
  }
  return c.default;
}

export function getStrictnessConfig(): StrictnessConfig {
  return loadConfig().strictness;
}

/** Set strictness globally (no category) or for one category. */
export function setStrictness(mode: Strictness, category?: RuleCategory): void {
  const c = loadConfig();
  if (category) c.strictness.byCategory[category] = mode;
  else c.strictness.default = mode;
  saveConfig(c);
}

/** Clear a category override so it follows the global default again. */
export function clearCategoryStrictness(category: RuleCategory): void {
  const c = loadConfig();
  delete c.strictness.byCategory[category];
  saveConfig(c);
}

/** Whether a rule requiring `required` fires at the `active` setting. */
export function meetsStrictness(required: Strictness, active: Strictness): boolean {
  return STRICTNESS_RANK[active] >= STRICTNESS_RANK[required];
}

/** Whether a rule should run right now, accounting for both the disable list
 *  and the category's strictness setting. */
export function isRuleActive(id: string, category: RuleCategory, minStrictness: Strictness): boolean {
  if (isRuleDisabled(id)) return false;
  return meetsStrictness(minStrictness, getStrictness(category));
}
