// Profile (PAP) store — baked physical asset profiles, keyed by asset path.
//
// JSON object keyed by asset_id under .scratch/. A profile splits DETERMINISTIC
// geometry/physics (baked from UE bounds + collision, see profile_bake) from
// QUALITATIVE semantics (AI-annotated affordances/regions, confidence-tagged,
// human-lockable via provenance). This is the store the Memory tab browses.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Profile, Mask } from './contracts.js';

let PATH_OVERRIDE: string | null = null;

function defaultPath(): string {
  return process.env.HAYBA_PROFILES ?? join(process.cwd(), '.scratch', 'profiles.json');
}
export function setProfilesPath(p: string | null): void { PATH_OVERRIDE = p; }
export function getProfilesPath(): string { return PATH_OVERRIDE ?? defaultPath(); }

function ensureDir(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function readAll(): Record<string, Profile> {
  const p = getProfilesPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, Profile>;
  } catch {
    return {};
  }
}

function writeAll(obj: Record<string, Profile>): void {
  const p = getProfilesPath();
  ensureDir(p);
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
}

export function loadProfiles(): Profile[] {
  return Object.values(readAll());
}

export function getProfile(assetId: string): Profile | null {
  return readAll()[assetId] ?? null;
}

export function profileMap(): Map<string, Profile> {
  return new Map(Object.entries(readAll()));
}

export function putProfile(profile: Profile): void {
  const all = readAll();
  all[profile.asset_id] = profile;
  writeAll(all);
}

/** Merge annotations (qualitative semantics) into an existing profile,
 *  recording edited/locked fields in provenance. Returns null if no base bake. */
export function annotateProfile(
  assetId: string,
  patch: Partial<Pick<Profile['semantics'], 'cls' | 'up' | 'front' | 'affordances'>>,
  opts: { lock?: string[]; auto?: boolean } = {},
): Profile | null {
  const all = readAll();
  const base = all[assetId];
  if (!base) return null;
  const edited: string[] = [...base.provenance.edited_fields];
  for (const k of Object.keys(patch)) {
    const field = `semantics.${k}`;
    if (!edited.includes(field)) edited.push(field);
  }
  const locked = Array.from(new Set([...base.provenance.locked, ...(opts.lock ?? [])]));
  const merged: Profile = {
    ...base,
    semantics: { ...base.semantics, ...patch },
    provenance: { auto: opts.auto ?? false, edited_fields: edited, locked },
  };
  all[assetId] = merged;
  writeAll(all);
  return merged;
}

export function removeProfile(assetId: string): boolean {
  const all = readAll();
  if (!(assetId in all)) return false;
  delete all[assetId];
  writeAll(all);
  return true;
}

export function getMask(assetId: string, maskId: string): Mask | null {
  const p = getProfile(assetId);
  return p?.masks?.find(m => m.id === maskId) ?? null;
}

export function addMask(assetId: string, mask: Mask): Profile | null {
  const all = readAll();
  const base = all[assetId];
  if (!base) return null;
  const masks = (base.masks ?? []).filter(m => m.id !== mask.id);
  masks.push(mask);
  const merged: Profile = { ...base, masks };
  all[assetId] = merged;
  writeAll(all);
  return merged;
}

export function removeMask(assetId: string, maskId: string): boolean {
  const all = readAll();
  const base = all[assetId];
  if (!base?.masks) return false;
  const next = base.masks.filter(m => m.id !== maskId);
  if (next.length === base.masks.length) return false;
  all[assetId] = { ...base, masks: next };
  writeAll(all);
  return true;
}
