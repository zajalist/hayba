// Grammar store — the persisted set of production rules.
//
// JSON file (a small object keyed by production id) under .scratch/, same
// scratch convention as the constraint and profile stores. The grammar is
// the language for expansions — a set of production rules that match symbols
// and emit operations.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Production } from './contracts.js';

let PATH_OVERRIDE: string | null = null;

function defaultPath(): string {
  if (process.env.HAYBA_GRAMMAR) return process.env.HAYBA_GRAMMAR;
  const base = process.env.HAYBA_PROFILES ? dirname(process.env.HAYBA_PROFILES) : join(process.cwd(), '.scratch');
  return join(base, 'grammar.json');
}

export function setGrammarPath(p: string | null): void {
  PATH_OVERRIDE = p;
}

export function getGrammarPath(): string {
  return PATH_OVERRIDE ?? defaultPath();
}

function ensureDir(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/**
 * Put the starter productions in place the first time this store is read.
 *
 * Without them plumb_grammar_expand is a language with no vocabulary: it
 * answers every seed with an empty plan and "No productions defined yet — call
 * plumb_production_define to author rules", which asks a user to write a
 * grammar before they have seen one work. The starter set (tunnels, shafts,
 * rooms, two builder styles) is the same one the room-grammar tests are
 * written against, so what ships is what is proven.
 *
 * Seeds only when the FILE is absent. An empty file is a user who deleted the
 * productions, and re-seeding over that would be the store arguing with them.
 *
 * And only at the DEFAULT location. A caller that names a path -- a test, or
 * anything pointed at a scratch grammar -- asked for that file's contents, not
 * for a starter set mixed into them.
 */
function seedIfAbsent(path: string): void {
  if (PATH_OVERRIDE || process.env.HAYBA_GRAMMAR) return;
  if (existsSync(path)) return;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const starter = join(here, 'starter-grammar.json');
    if (!existsSync(starter)) return;
    ensureDir(path);
    writeFileSync(path, readFileSync(starter, 'utf-8'), 'utf-8');
  } catch {
    // A missing or unreadable starter must not stop the store working; the
    // caller simply gets an empty grammar, which is the old behaviour.
  }
}

function readAll(): Record<string, Production> {
  const p = getGrammarPath();
  seedIfAbsent(p);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, Production>;
  } catch {
    return {};
  }
}

function writeAll(obj: Record<string, Production>): void {
  const p = getGrammarPath();
  ensureDir(p);
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
}

const EMITS = new Set(['shell', 'asset', 'symbol', 'scatter', 'decal', 'fill']);

export function validateProduction(p: Production): string[] {
  const e: string[] = [];
  if (!p.id) e.push('missing id');
  if (!p.lhs?.kind) e.push('missing lhs.kind');
  if (!Array.isArray(p.rhs) || p.rhs.length === 0) e.push('rhs must be non-empty');
  for (const op of p.rhs ?? []) {
    if (!EMITS.has((op as any).emit)) e.push(`bad emit: ${(op as any).emit}`);
  }
  if (typeof p.priority !== 'number') e.push('priority must be a number');
  return e;
}

export function putProduction(p: Production): void {
  const errs = validateProduction(p);
  if (errs.length) throw new Error(errs.join('; '));
  const o = readAll();
  o[p.id] = p;
  writeAll(o);
}

export function getProduction(id: string): Production | null {
  return readAll()[id] ?? null;
}

export function listProductions(): Production[] {
  return Object.values(readAll());
}

export function removeProduction(id: string): boolean {
  const o = readAll();
  if (!(id in o)) return false;
  delete o[id];
  writeAll(o);
  return true;
}

export function productionMap(): Map<string, Production> {
  return new Map(Object.entries(readAll()));
}
