// Constraint library store — the persisted set of bound constraints.
//
// JSON file (a small object keyed by constraint id) under .scratch/, same
// scratch convention as the validator history. The library IS the language:
// it grows by adding asset/tag→primitive bindings, never by extending grammar.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Constraint } from './contracts.js';
import { toObjectPath } from './contracts.js';
import { primitivesById } from './primitives.js';

let PATH_OVERRIDE: string | null = null;

function defaultPath(): string {
  return process.env.HAYBA_CONSTRAINTS ?? join(process.cwd(), '.scratch', 'constraints.json');
}
export function setConstraintsPath(p: string | null): void { PATH_OVERRIDE = p; }
export function getConstraintsPath(): string { return PATH_OVERRIDE ?? defaultPath(); }

function ensureDir(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export function loadConstraints(): Constraint[] {
  const p = getConstraintsPath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, Constraint>;
    return Object.values(raw);
  } catch {
    return [];
  }
}

function writeAll(list: Constraint[]): void {
  const p = getConstraintsPath();
  ensureDir(p);
  const obj: Record<string, Constraint> = {};
  for (const c of list) obj[c.id] = c;
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
}

export interface ValidationError { field: string; message: string; }

/** Define-time validation: closed-primitive-set + known params + valid binding.
 *  This is where AI-flop is stopped — a constraint that doesn't fit the menu is
 *  rejected before it ever reaches the evaluator. */
export function validateConstraint(c: Partial<Constraint>): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!c.id || typeof c.id !== 'string') errs.push({ field: 'id', message: 'id is required' });
  const prim = c.primitive ? primitivesById().get(c.primitive) : undefined;
  if (!c.primitive) errs.push({ field: 'primitive', message: 'primitive is required' });
  else if (!prim) errs.push({ field: 'primitive', message: `unknown primitive "${c.primitive}" — must be one of ${[...primitivesById().keys()].join(', ')}` });
  if (!c.binding || (!c.binding.asset && !c.binding.tag)) {
    errs.push({ field: 'binding', message: 'binding must set exactly one of {asset, tag}' });
  } else if (c.binding.asset && c.binding.tag) {
    errs.push({ field: 'binding', message: 'binding must set exactly one of {asset, tag}, not both' });
  } else if (c.binding.tag && (!c.binding.tag.axis || !c.binding.tag.value)) {
    errs.push({ field: 'binding.tag', message: 'tag binding needs both axis and value' });
  }
  if (prim && c.params) {
    const known = new Set(prim.params);
    for (const k of Object.keys(c.params)) {
      if (!known.has(k)) errs.push({ field: `params.${k}`, message: `"${k}" is not a param of "${prim.id}" (allowed: ${prim.params.join(', ')})` });
    }
  }
  return errs;
}

export function upsertConstraint(c: Constraint): { ok: boolean; errors: ValidationError[] } {
  const errors = validateConstraint(c);
  if (errors.length) return { ok: false, errors };
  // Normalize an asset binding to the full object path so the in-editor Studio
  // (which queries constraints by the suffixed object path) actually matches it.
  const normalized: Constraint = c.binding?.asset
    ? { ...c, binding: { ...c.binding, asset: toObjectPath(c.binding.asset) } }
    : c;
  const list = loadConstraints().filter(x => x.id !== normalized.id);
  list.push({ enabled: true, ...normalized });
  writeAll(list);
  return { ok: true, errors: [] };
}

export function removeConstraint(id: string): boolean {
  const list = loadConstraints();
  const next = list.filter(c => c.id !== id);
  if (next.length === list.length) return false;
  writeAll(next);
  return true;
}

/** Constraints whose binding could apply to a given asset/tag set. */
export function constraintsFor(asset?: string, tags?: Record<string, string>): Constraint[] {
  const assetObj = asset ? toObjectPath(asset) : asset;
  return loadConstraints().filter(c => {
    if (c.enabled === false) return false;
    if (c.binding.asset) return c.binding.asset === assetObj;
    if (c.binding.tag) return tags?.[c.binding.tag.axis] === c.binding.tag.value;
    return false;
  });
}
