// Lesson store — the accumulated `[[slug]]` knowledge that constraints and
// validator rules cite. Distinct from the Profile/Constraint stores: a lesson
// is a durable, human-readable note ("SM_GiantTree_01 pivot sits +380 above the
// base") that explains WHY a constraint exists. The Semantic Studio's Memory /
// Lessons panel browses these; constraints reference them by slug.
//
// JSON object keyed by slug, under .scratch/ (env HAYBA_LESSONS override).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Lesson {
  slug: string;        // kebab-case id, matches the [[slug]] refs
  title: string;
  body: string;
  refs?: string[];     // related slugs / asset paths
  tags?: string[];
  updated_at?: string; // ISO
}

let PATH_OVERRIDE: string | null = null;

function defaultPath(): string {
  return process.env.HAYBA_LESSONS ?? join(process.cwd(), '.scratch', 'lessons.json');
}
export function setLessonsPath(p: string | null): void { PATH_OVERRIDE = p; }
export function getLessonsPath(): string { return PATH_OVERRIDE ?? defaultPath(); }

function ensureDir(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function readAll(): Record<string, Lesson> {
  const p = getLessonsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, Lesson>;
  } catch {
    return {};
  }
}

function writeAll(obj: Record<string, Lesson>): void {
  const p = getLessonsPath();
  ensureDir(p);
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
}

export function loadLessons(): Lesson[] {
  return Object.values(readAll());
}

export function getLesson(slug: string): Lesson | null {
  return readAll()[slug] ?? null;
}

export interface LessonValidationError { field: string; message: string; }

const SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export function validateLesson(l: Partial<Lesson>): LessonValidationError[] {
  const errs: LessonValidationError[] = [];
  if (!l.slug || typeof l.slug !== 'string') errs.push({ field: 'slug', message: 'slug is required' });
  else if (!SLUG_RE.test(l.slug)) errs.push({ field: 'slug', message: 'slug must be kebab/snake-case (a-z, 0-9, -, _)' });
  if (!l.title || typeof l.title !== 'string') errs.push({ field: 'title', message: 'title is required' });
  if (!l.body || typeof l.body !== 'string') errs.push({ field: 'body', message: 'body is required' });
  return errs;
}

export function upsertLesson(l: Lesson, nowIso: string): { ok: boolean; errors: LessonValidationError[] } {
  const errors = validateLesson(l);
  if (errors.length) return { ok: false, errors };
  const all = readAll();
  all[l.slug] = { ...l, updated_at: nowIso };
  writeAll(all);
  return { ok: true, errors: [] };
}

export function removeLesson(slug: string): boolean {
  const all = readAll();
  if (!(slug in all)) return false;
  delete all[slug];
  writeAll(all);
  return true;
}
