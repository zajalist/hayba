import { VALIDATION_NUDGE } from './hayba-tool-meta.js';
import { warningIdForFinding } from '../chat/warning-identity.js';
import { UNVERIFIED_MUTATION_WARNING } from './response-evidence.js';
import type { AdvisoryVerbosity } from './disabled-tools-watcher.js';
import type { RichToolResult, ToolContent } from './types.js';

function isWarningField(field: string): boolean {
  const name = field.toLowerCase();
  return name === 'warning' || name === 'warnings' || name.endsWith('_warning') || name.endsWith('_warnings');
}

function isTipField(field: string): boolean {
  const name = field.toLowerCase();
  return (
    name === 'tip' ||
    name === 'tips' ||
    name === 'hint' ||
    name === 'hints' ||
    name === 'suggestion' ||
    name === 'suggestions' ||
    name.endsWith('_tip') ||
    name.endsWith('_tips') ||
    name.endsWith('_hint') ||
    name.endsWith('_hints') ||
    name.endsWith('_suggestion') ||
    name.endsWith('_suggestions')
  );
}

function findingAllowed(value: unknown, verbosity: AdvisoryVerbosity): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const severity = String((value as Record<string, unknown>).severity ?? '').toLowerCase();
  if (severity === 'error' || severity === 'fatal') return true;
  if (severity === 'warning') return verbosity !== 'errors_only';
  return verbosity === 'errors_warnings_and_tips';
}

/** IDs are machine evidence, even when optional warning prose is hidden. */
function validatorWarningIds(result: RichToolResult): string[] {
  const ids = new Set<string>();
  const structuredRules = new Set<string>();
  let ordinal = 0;
  const add = (finding: Record<string, unknown>): void => {
    const id = warningIdForFinding(finding, ordinal++);
    if (id && ids.size < 65) ids.add(id);
  };
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 6 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const object = value as Record<string, unknown>;
    if (object.severity === 'warning') {
      if (typeof object.ruleId === 'string') structuredRules.add(object.ruleId);
      add(object);
    }
    for (const child of Object.values(object)) visit(child, depth + 1);
  };
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    try { visit(JSON.parse(block.text)); } catch { /* prose is handled above */ }
  }
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    for (const match of block.text.matchAll(/\[validator:warning\]\s+([a-z][a-z0-9_]{0,79}):/g)) {
      if (!structuredRules.has(match[1]!)) add({ ruleId: match[1], message: match[0] });
    }
  }
  return [...ids];
}

function filterJson(value: unknown, verbosity: AdvisoryVerbosity, parentKey?: string): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const filtered = value.map((item) => {
      const next = filterJson(item, verbosity, parentKey);
      changed ||= next.changed;
      return next.value;
    });
    return { value: filtered, changed };
  }
  if (!value || typeof value !== 'object') return { value, changed: false };

  let changed = false;
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (
      (verbosity === 'errors_only' && isWarningField(key) &&
        !(parentKey === 'counts' && key === 'warning' && typeof raw === 'number')) ||
      (verbosity !== 'errors_warnings_and_tips' && isTipField(key))
    ) {
      changed = true;
      continue;
    }

    if (key === 'findings' && Array.isArray(raw)) {
      const allowed = raw.filter((finding) => findingAllowed(finding, verbosity));
      if (allowed.length !== raw.length) changed = true;
      const next = filterJson(allowed, verbosity, key);
      changed ||= next.changed;
      output[key] = next.value;
      continue;
    }

    const next = filterJson(raw, verbosity, key);
    changed ||= next.changed;
    output[key] = next.value;
  }
  return { value: output, changed };
}

function filterValidatorProse(text: string, verbosity: AdvisoryVerbosity): string | null {
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0 || !nonEmpty.every((line) => /^\[validator:(error|warning|info)\]/.test(line.trim()))) {
    return text;
  }
  const kept = nonEmpty.filter((line) => {
    if (/^\[validator:error\]/.test(line.trim())) return true;
    if (/^\[validator:warning\]/.test(line.trim())) return verbosity !== 'errors_only';
    return verbosity === 'errors_warnings_and_tips';
  });
  return kept.length > 0 ? kept.join('\n') : null;
}

function filterText(text: string, verbosity: AdvisoryVerbosity): string | null {
  if (verbosity !== 'errors_warnings_and_tips' && text === VALIDATION_NUDGE) return null;
  if (verbosity === 'errors_only' && text === UNVERIFIED_MUTATION_WARNING) return null;

  const validator = filterValidatorProse(text, verbosity);
  if (validator === null || validator !== text) return validator;

  try {
    const parsed = JSON.parse(text) as unknown;
    const filtered = filterJson(parsed, verbosity);
    return filtered.changed ? JSON.stringify(filtered.value, null, 2) : text;
  } catch {
    // Arbitrary prose has no dependable severity. Preserve it rather than
    // deleting real errors by guessing from words such as "warning".
    return text;
  }
}

/**
 * Enforce the plugin's advisory setting at the final Node MCP result boundary.
 * Native and TS-only tools therefore cannot disagree about warning/tip policy.
 */
export function applyAdvisoryVerbosity<T extends RichToolResult>(result: T, verbosity: AdvisoryVerbosity): T {
  if (!Array.isArray(result.content)) return result;

  const warningIds = validatorWarningIds(result);
  if (verbosity === 'errors_warnings_and_tips' && warningIds.length === 0) return result;

  let changed = false;
  const content: ToolContent[] = [];
  for (const block of result.content) {
    if (block.type !== 'text') {
      content.push(block);
      continue;
    }
    const text = filterText(block.text, verbosity);
    if (text === null) {
      changed = true;
      continue;
    }
    if (text !== block.text) changed = true;
    content.push(text === block.text ? block : { ...block, text });
  }
  if (warningIds.length > 0) {
    content.push({ type: 'text', text: JSON.stringify({ validator: { warning_ids: warningIds } }) });
    changed = true;
  }
  return changed ? { ...result, content } : result;
}
