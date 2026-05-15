/**
 * MCP handler surface for the Architecture Culture Studio.
 *
 * Each export is an async (args) => result function matching the spec in
 * docs/superpowers/plans/2026-05-12-tectonic-pillar-roadmap.md §MCP tools.
 *
 * __setDataRoot() is exported for test isolation — in production the default
 * data root is packages/architecture/src/data/cultures, resolved relative to
 * this file via import.meta.url. This avoids any runtime package-resolution
 * tricks and keeps the path computable without a build step.
 *
 * For _update_rule / _delete_rule we accept an optional scope param (same
 * shape as add_rule) to disambiguate when a rule id exists in both culture and
 * era scope. When scope is omitted we search culture rules first, then all
 * eras. This is the simplest ergonomic choice — callers don't need to track
 * scope after creation.
 */

import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  seedCulture,
  writeCulture,
  readCulture,
  listCultures,
  deleteCulture,
  validateCulture,
  resolveRules,
} from '@hayba/architecture/culture';
import type {
  Culture, Era, Material, Ornament, TagAxis, Rule,
} from '@hayba/architecture/schema-v2';

// ── Data root resolution ─────────────────────────────────────────────────────

// Default: packages/architecture/src/data/cultures
// From this file:  packages/hayba/src/tools/worldbuilding/architecture-handlers.ts
// Relative depth:  ../../../../architecture/src/data/cultures
const DEFAULT_DATA_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', 'architecture', 'src', 'data', 'cultures',
);

let _dataRoot: string = DEFAULT_DATA_ROOT;

/** Test-only: override the data root so tests can use a temp directory. */
export function __setDataRoot(dir: string): void {
  _dataRoot = dir;
}

function dataRoot(): string {
  return _dataRoot;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function load(id: string): Promise<Culture> {
  return readCulture(dataRoot(), id);
}

async function save(culture: Culture): Promise<void> {
  return writeCulture(dataRoot(), culture);
}

// Top-level field merge: scalar fields replaced, arrays replaced wholesale.
function mergeTopLevel<T extends object>(base: T, partial: Partial<T>): T {
  return { ...base, ...partial };
}

// ── Read handlers ─────────────────────────────────────────────────────────────

export async function architecture_list_cultures(
  _args: Record<string, never> | object,
): Promise<{ id: string; name: string; eraCount: number }[]> {
  return listCultures(dataRoot());
}

export async function architecture_get_culture(
  args: { id: string },
): Promise<Culture> {
  return load(args.id);
}

export async function architecture_resolve_rules(
  args: { cultureId: string; eraId: string; scenario: string; tagState: Record<string, string> },
): Promise<Rule['assigns']> {
  const culture = await load(args.cultureId);
  return resolveRules(culture, args.eraId, args.scenario, args.tagState);
}

export async function architecture_validate_culture(
  args: { id: string },
): Promise<{ ok: boolean; issues: { path: string; message: string; severity: string }[] }> {
  const culture = await load(args.id);
  return validateCulture(culture);
}

// ── Culture CRUD ──────────────────────────────────────────────────────────────

export async function architecture_create_culture(args: {
  id: string;
  name: string;
  region: string;
  climate: string;
  seedFromPresets?: boolean;
}): Promise<void> {
  // seedFromPresets defaults to true (omitting it seeds from presets)
  const culture = (args.seedFromPresets === false)
    ? { id: args.id, name: args.name, region: args.region, climate: args.climate, tagAxes: [], materials: [], ornaments: [], rules: [], eras: [] }
    : seedCulture({ id: args.id, name: args.name, region: args.region, climate: args.climate });
  await save(culture);
}

export async function architecture_update_culture(args: {
  id: string;
  partial: Partial<Omit<Culture, 'id'>>;
}): Promise<void> {
  const culture = await load(args.id);
  const updated = mergeTopLevel(culture, args.partial as Partial<Culture>);
  await save(updated);
}

export async function architecture_delete_culture(args: { id: string }): Promise<void> {
  await deleteCulture(dataRoot(), args.id);
}

// ── Era CRUD ──────────────────────────────────────────────────────────────────

export async function architecture_add_era(args: {
  cultureId: string;
  era: Era;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.eras = [...culture.eras, args.era];
  await save(culture);
}

export async function architecture_update_era(args: {
  cultureId: string;
  eraId: string;
  partial: Partial<Era>;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.eras = culture.eras.map(e =>
    e.id === args.eraId ? mergeTopLevel(e, args.partial) : e,
  );
  await save(culture);
}

export async function architecture_delete_era(args: {
  cultureId: string;
  eraId: string;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.eras = culture.eras.filter(e => e.id !== args.eraId);
  await save(culture);
}

// ── Material CRUD ─────────────────────────────────────────────────────────────

export async function architecture_add_material(args: {
  cultureId: string;
  material: Material;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.materials = [...culture.materials, args.material];
  await save(culture);
}

export async function architecture_update_material(args: {
  cultureId: string;
  materialId: string;
  partial: Partial<Material>;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.materials = culture.materials.map(m =>
    m.id === args.materialId ? mergeTopLevel(m, args.partial) : m,
  );
  await save(culture);
}

export async function architecture_delete_material(args: {
  cultureId: string;
  materialId: string;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.materials = culture.materials.filter(m => m.id !== args.materialId);
  await save(culture);
}

// ── Ornament CRUD ─────────────────────────────────────────────────────────────

export async function architecture_add_ornament(args: {
  cultureId: string;
  ornament: Ornament;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.ornaments = [...culture.ornaments, args.ornament];
  await save(culture);
}

export async function architecture_update_ornament(args: {
  cultureId: string;
  ornamentId: string;
  partial: Partial<Ornament>;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.ornaments = culture.ornaments.map(o =>
    o.id === args.ornamentId ? mergeTopLevel(o, args.partial) : o,
  );
  await save(culture);
}

export async function architecture_delete_ornament(args: {
  cultureId: string;
  ornamentId: string;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.ornaments = culture.ornaments.filter(o => o.id !== args.ornamentId);
  await save(culture);
}

// ── TagAxis CRUD ──────────────────────────────────────────────────────────────

export async function architecture_add_tag_axis(args: {
  cultureId: string;
  axis: TagAxis;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.tagAxes = [...culture.tagAxes, args.axis];
  await save(culture);
}

export async function architecture_update_tag_axis(args: {
  cultureId: string;
  axisId: string;
  partial: Partial<TagAxis>;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.tagAxes = culture.tagAxes.map(a =>
    a.id === args.axisId ? mergeTopLevel(a, args.partial) : a,
  );
  await save(culture);
}

export async function architecture_delete_tag_axis(args: {
  cultureId: string;
  axisId: string;
}): Promise<void> {
  const culture = await load(args.cultureId);
  culture.tagAxes = culture.tagAxes.filter(a => a.id !== args.axisId);
  await save(culture);
}

// ── Rule CRUD ─────────────────────────────────────────────────────────────────

type RuleScope = 'culture' | { era: string };

export async function architecture_add_rule(args: {
  cultureId: string;
  rule: Rule;
  scope: RuleScope;
}): Promise<void> {
  const culture = await load(args.cultureId);
  if (args.scope === 'culture') {
    culture.rules = [...culture.rules, args.rule];
  } else {
    const eraId = (args.scope as { era: string }).era;
    culture.eras = culture.eras.map(e =>
      e.id === eraId ? { ...e, rules: [...e.rules, args.rule] } : e,
    );
  }
  await save(culture);
}

export async function architecture_update_rule(args: {
  cultureId: string;
  ruleId: string;
  partial: Partial<Rule>;
  scope?: RuleScope;
}): Promise<void> {
  const culture = await load(args.cultureId);
  const updateList = (rules: Rule[]) =>
    rules.map(r => r.id === args.ruleId ? mergeTopLevel(r, args.partial) : r);

  if (args.scope === undefined) {
    // Search culture-level first, then eras
    const inCulture = culture.rules.some(r => r.id === args.ruleId);
    if (inCulture) {
      culture.rules = updateList(culture.rules);
    } else {
      culture.eras = culture.eras.map(e => ({
        ...e,
        rules: updateList(e.rules),
      }));
    }
  } else if (args.scope === 'culture') {
    culture.rules = updateList(culture.rules);
  } else {
    const eraId = (args.scope as { era: string }).era;
    culture.eras = culture.eras.map(e =>
      e.id === eraId ? { ...e, rules: updateList(e.rules) } : e,
    );
  }
  await save(culture);
}

export async function architecture_delete_rule(args: {
  cultureId: string;
  ruleId: string;
  scope?: RuleScope;
}): Promise<void> {
  const culture = await load(args.cultureId);
  const removeFrom = (rules: Rule[]) => rules.filter(r => r.id !== args.ruleId);

  if (args.scope === undefined) {
    // Remove from culture-level and all eras (belt-and-suspenders)
    culture.rules = removeFrom(culture.rules);
    culture.eras = culture.eras.map(e => ({ ...e, rules: removeFrom(e.rules) }));
  } else if (args.scope === 'culture') {
    culture.rules = removeFrom(culture.rules);
  } else {
    const eraId = (args.scope as { era: string }).era;
    culture.eras = culture.eras.map(e =>
      e.id === eraId ? { ...e, rules: removeFrom(e.rules) } : e,
    );
  }
  await save(culture);
}
