import fs from 'fs';
import path from 'path';
import type { Culture } from '../schema-v2.js';

export type Issue = { path: string; message: string; severity: 'error' | 'warning' };
export type ValidationResult = { ok: boolean; issues: Issue[] };

const KEBAB_RE = /^[a-z][a-z0-9-]*$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isKebab(s: string): boolean {
  return KEBAB_RE.test(s);
}

function isHex(s: string): boolean {
  return HEX_RE.test(s);
}

export function validateCulture(culture: Culture, opts?: { rootDir?: string }): ValidationResult {
  const issues: Issue[] = [];

  function err(p: string, message: string) {
    issues.push({ path: p, message, severity: 'error' });
  }
  function warn(p: string, message: string) {
    issues.push({ path: p, message, severity: 'warning' });
  }

  // Top-level id kebab check
  if (!isKebab(culture.id)) {
    err('id', `id "${culture.id}" must be kebab-case`);
  }

  // Build lookup sets
  const materialIds = new Set(culture.materials.map(m => m.id));
  const ornamentIds = new Set(culture.ornaments.map(o => o.id));

  // Build tagAxis+value lookup
  const axisValues: Map<string, Set<string>> = new Map();
  for (const axis of culture.tagAxes) {
    axisValues.set(axis.id, new Set(axis.values.map(v => v.id)));
  }

  // --- Materials: unique ids + kebab ---
  {
    const seen = new Set<string>();
    for (let i = 0; i < culture.materials.length; i++) {
      const m = culture.materials[i];
      if (!isKebab(m.id)) {
        err(`materials[${i}].id`, `id "${m.id}" must be kebab-case`);
      }
      if (seen.has(m.id)) {
        err(`materials[${i}].id`, `duplicate material id "${m.id}"`);
      }
      seen.add(m.id);
    }
  }

  // --- Ornaments: unique ids + kebab ---
  {
    const seen = new Set<string>();
    for (let i = 0; i < culture.ornaments.length; i++) {
      const o = culture.ornaments[i];
      if (!isKebab(o.id)) {
        err(`ornaments[${i}].id`, `id "${o.id}" must be kebab-case`);
      }
      if (seen.has(o.id)) {
        err(`ornaments[${i}].id`, `duplicate ornament id "${o.id}"`);
      }
      seen.add(o.id);
    }
  }

  // --- TagAxes: unique ids + kebab ---
  {
    const seen = new Set<string>();
    for (let i = 0; i < culture.tagAxes.length; i++) {
      const ax = culture.tagAxes[i];
      if (!isKebab(ax.id)) {
        err(`tagAxes[${i}].id`, `id "${ax.id}" must be kebab-case`);
      }
      if (seen.has(ax.id)) {
        err(`tagAxes[${i}].id`, `duplicate tagAxis id "${ax.id}"`);
      }
      seen.add(ax.id);
    }
  }

  // --- Top-level rules ---
  validateRuleList(culture.rules, 'rules', axisValues, materialIds, ornamentIds, issues);

  // --- Eras ---
  {
    const seenIds = new Set<string>();
    for (let i = 0; i < culture.eras.length; i++) {
      const era = culture.eras[i];
      const ep = `eras[${i}]`;

      if (!isKebab(era.id)) {
        err(`${ep}.id`, `id "${era.id}" must be kebab-case`);
      }
      if (seenIds.has(era.id)) {
        err(`${ep}.id`, `duplicate era id "${era.id}"`);
      }
      seenIds.add(era.id);

      // dateRange check
      if (era.dateRange[0] >= era.dateRange[1]) {
        err(`${ep}.dateRange`, `dateRange[0] must be less than dateRange[1]`);
      }

      // palette hex check
      for (let c = 0; c < era.defaults.palette.length; c++) {
        const col = era.defaults.palette[c];
        if (!isHex(col)) {
          err(`${ep}.defaults.palette[${c}]`, `"${col}" is not a valid hex color`);
        }
      }

      // era-level rules
      validateRuleList(era.rules, `${ep}.rules`, axisValues, materialIds, ornamentIds, issues);

      // v2: validate typologyMix keys against a typology registry
      // Currently accept any non-empty string key
    }

    // Overlap check — sort eras by start, warn on overlap (b.start < a.end && b.end > a.start)
    const sorted = [...culture.eras].map((e, origIdx) => ({ e, origIdx }))
      .filter(({ e }) => e.dateRange[0] < e.dateRange[1]) // skip invalid ones already flagged
      .sort((a, b) => a.e.dateRange[0] - b.e.dateRange[0]);

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i].e;
      const b = sorted[i + 1].e;
      if (b.dateRange[0] < a.dateRange[1] && b.dateRange[1] > a.dateRange[0]) {
        warn(`eras`, `eras "${a.id}" and "${b.id}" overlap (${a.dateRange[1]} > ${b.dateRange[0]})`);
      }
    }
  }

  // --- File path checks (only when rootDir is provided) ---
  if (opts?.rootDir) {
    const base = path.join(opts.rootDir, culture.id);
    for (const mat of culture.materials) {
      if (mat.referenceImagePath && !fs.existsSync(path.join(base, mat.referenceImagePath))) {
        err(`materials[material:${mat.id}].referenceImagePath`, `file not found: ${mat.referenceImagePath}`);
      }
    }
    for (const orn of culture.ornaments) {
      if (orn.pbrTexturePath && !fs.existsSync(path.join(base, orn.pbrTexturePath))) {
        err(`ornaments[ornament:${orn.id}].pbrTexturePath`, `file not found: ${orn.pbrTexturePath}`);
      }
    }
  }

  const ok = issues.every(i => i.severity !== 'error');
  return { ok, issues };
}

function validateRuleList(
  rules: Culture['rules'],
  prefix: string,
  axisValues: Map<string, Set<string>>,
  materialIds: Set<string>,
  ornamentIds: Set<string>,
  issues: Issue[],
) {
  function err(p: string, message: string) {
    issues.push({ path: p, message, severity: 'error' });
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const rp = `${prefix}[${i}]`;

    if (!KEBAB_RE.test(rule.id)) {
      err(`${rp}.id`, `id "${rule.id}" must be kebab-case`);
    }
    if (seenIds.has(rule.id)) {
      err(`${rp}.id`, `duplicate rule id "${rule.id}"`);
    }
    seenIds.add(rule.id);

    // tagMatches axis + value validation
    for (const [axisId, valueId] of Object.entries(rule.conditions.tagMatches)) {
      const axisVals = axisValues.get(axisId);
      if (!axisVals) {
        err(`${rp}.conditions.tagMatches.${axisId}`, `unknown tag axis "${axisId}"`);
      } else if (!axisVals.has(valueId)) {
        err(`${rp}.conditions.tagMatches.${axisId}`, `unknown value "${valueId}" for axis "${axisId}"`);
      }
    }

    // materialId reference
    if (rule.assigns.materialId !== undefined) {
      if (!materialIds.has(rule.assigns.materialId)) {
        err(`${rp}.assigns.materialId`, `unknown material id "${rule.assigns.materialId}"`);
      }
    }

    // ornamentIds references
    if (rule.assigns.ornamentIds) {
      for (let j = 0; j < rule.assigns.ornamentIds.length; j++) {
        const oid = rule.assigns.ornamentIds[j];
        if (!ornamentIds.has(oid)) {
          err(`${rp}.assigns.ornamentIds[${j}]`, `unknown ornament id "${oid}"`);
        }
      }
    }
  }
}
