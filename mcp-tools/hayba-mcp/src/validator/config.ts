// Per-rule enable/disable configuration.
//
// Persisted to JSON so the UE plugin's Configure panel can toggle rules
// without round-tripping through MCP. Schema is tiny: `{ disabled: string[] }`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

interface ValidatorConfig {
  disabled: string[];
}

function loadConfig(): ValidatorConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { disabled: [] };
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ValidatorConfig>;
    return { disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [] };
  } catch {
    return { disabled: [] };
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
  if (!disabled && has) c.disabled = c.disabled.filter(x => x !== id);
  saveConfig(c);
}

export function listDisabledRules(): string[] {
  return loadConfig().disabled.slice();
}
