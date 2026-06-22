// Study-request queue — the "Study with AI" button in the Semantic Studio
// appends a request here; the agent drains it (plumb_study_take), studies each
// asset, and writes masks/constraints back to the stores. The bridge that turns
// a button click into AI authoring.
//
// JSONL under .scratch/ (one {asset, ts} per line), env HAYBA_STUDY_REQUESTS.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface StudyRequest { asset: string; ts: string; }

let PATH_OVERRIDE: string | null = null;

function defaultPath(): string {
  if (process.env.HAYBA_STUDY_REQUESTS) return process.env.HAYBA_STUDY_REQUESTS;
  const base = process.env.HAYBA_PROFILES
    ? dirname(process.env.HAYBA_PROFILES)
    : join(process.cwd(), '.scratch');
  return join(base, 'study-requests.jsonl');
}
export function setStudyRequestsPath(p: string | null): void { PATH_OVERRIDE = p; }
export function getStudyRequestsPath(): string { return PATH_OVERRIDE ?? defaultPath(); }

function ensureDir(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/** Enqueue a study request (the UE button writes the file directly; this mirrors
 *  it for tests / programmatic use). */
export function enqueueStudyRequest(asset: string, ts: string): void {
  const p = getStudyRequestsPath();
  ensureDir(p);
  appendFileSync(p, JSON.stringify({ asset, ts }) + '\n', 'utf-8');
}

/** Read every pending request and clear the queue. Returns de-duplicated assets
 *  (latest request order preserved). */
export function takeStudyRequests(): StudyRequest[] {
  const p = getStudyRequestsPath();
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf-8').split('\n').filter(l => l.trim().length > 0);
  writeFileSync(p, '', 'utf-8'); // drain
  const seen = new Set<string>();
  const out: StudyRequest[] = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as StudyRequest;
      if (r.asset && !seen.has(r.asset)) { seen.add(r.asset); out.push(r); }
    } catch { /* skip malformed */ }
  }
  return out;
}
