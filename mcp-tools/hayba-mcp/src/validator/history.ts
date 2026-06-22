// Persistent validator finding history.
//
// JSONL file (one finding per line) so the UE plugin can watch + tail the same
// stream without a transport bridge to the MCP server. Cheap in-memory cache
// keeps appends fast; reads re-parse from disk (correct for typical history
// sizes < 10k findings — promote to SQLite if that ever becomes painful).

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ValidatorFinding } from './rules.js';

let HISTORY_PATH_OVERRIDE: string | null = null;

function defaultHistoryPath(): string {
  const env = process.env.HAYBA_VALIDATOR_HISTORY;
  if (env) return env;
  // Repo-root .scratch/ — same convention as the rest of the scratch artefacts.
  const cwd = process.cwd();
  return join(cwd, '.scratch', 'validator-history.jsonl');
}

/** Override the on-disk path. Used by tests to write to a tmp file. */
export function setHistoryPath(p: string | null): void {
  HISTORY_PATH_OVERRIDE = p;
}

export function getHistoryPath(): string {
  return HISTORY_PATH_OVERRIDE ?? defaultHistoryPath();
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export interface AppendOptions {
  /** Skip writing duplicates with the same timestamp+ruleId. */
  dedupe?: boolean;
}

export async function appendFinding(f: ValidatorFinding, opts: AppendOptions = {}): Promise<void> {
  const path = getHistoryPath();
  ensureDir(path);

  if (opts.dedupe && existsSync(path)) {
    const findings = await listFindings({ includeResolved: true });
    const dup = findings.some(x => x.timestamp === f.timestamp && x.ruleId === f.ruleId);
    if (dup) return;
  }

  appendFileSync(path, JSON.stringify(f) + '\n', 'utf-8');
}

export interface ListOptions {
  limit?: number;
  sinceIso?: string;
  includeResolved?: boolean;
  ruleIds?: string[];
  severities?: Array<ValidatorFinding['severity']>;
}

export async function listFindings(opts: ListOptions = {}): Promise<ValidatorFinding[]> {
  const path = getHistoryPath();
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.size === 0) return [];

  const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim().length > 0);
  const findings: ValidatorFinding[] = [];
  for (const line of lines) {
    try {
      findings.push(JSON.parse(line) as ValidatorFinding);
    } catch {
      // skip malformed lines (partial write, manual edit) — keep tailing.
    }
  }

  let out = findings;
  if (!opts.includeResolved) out = out.filter(f => !f.resolved);
  if (opts.sinceIso) out = out.filter(f => f.timestamp >= opts.sinceIso!);
  if (opts.ruleIds && opts.ruleIds.length) {
    const set = new Set(opts.ruleIds);
    out = out.filter(f => set.has(f.ruleId));
  }
  if (opts.severities && opts.severities.length) {
    const set = new Set(opts.severities);
    out = out.filter(f => set.has(f.severity));
  }
  if (opts.limit && opts.limit > 0) out = out.slice(-opts.limit);

  return out;
}

export async function markResolved(timestamp: string, resolved: boolean): Promise<boolean> {
  const path = getHistoryPath();
  if (!existsSync(path)) return false;
  const all = await listFindings({ includeResolved: true });
  let changed = false;
  const updated = all.map(f => {
    if (f.timestamp === timestamp) {
      changed = true;
      return resolved
        ? { ...f, resolved: true, resolvedAt: new Date().toISOString() }
        : { ...f, resolved: false, resolvedAt: undefined };
    }
    return f;
  });
  if (changed) {
    writeFileSync(path, updated.map(f => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
  }
  return changed;
}

/** Replace every finding whose ruleId starts with `prefix` with `replacement`,
 *  keeping all other findings. Used to merge a fresh PLUMB validation pass into
 *  the single findings store without accumulating stale entries. */
export async function replaceFindingsWithPrefix(prefix: string, replacement: ValidatorFinding[]): Promise<void> {
  const path = getHistoryPath();
  ensureDir(path);
  const existing = await listFindings({ includeResolved: true });
  const kept = existing.filter(f => !f.ruleId.startsWith(prefix));
  const all = [...kept, ...replacement];
  writeFileSync(path, all.map(f => JSON.stringify(f)).join('\n') + (all.length ? '\n' : ''), 'utf-8');
}

export async function clearHistory(): Promise<{ removed: number }> {
  const path = getHistoryPath();
  if (!existsSync(path)) return { removed: 0 };
  const all = await listFindings({ includeResolved: true });
  writeFileSync(path, '', 'utf-8');
  return { removed: all.length };
}
