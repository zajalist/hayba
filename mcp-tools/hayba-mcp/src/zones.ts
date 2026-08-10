import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PROJECTS_BASE } from './projects.js';
import { isStorageUuid, requireStorageFileStem, requireStorageUuid, resolveStorageChild } from './storage-path.js';

export interface Zone {
  id: string;
  name: string;
  description: string;
  color: string;
  type: 'terrain' | 'placement';
  placementCategory?: 'foliage' | 'vegetation' | 'rocks' | 'props';
  maskPath: string;
  visible: boolean;
}

export interface ZoneSession {
  projectId: string;
  zones: Zone[];
  masks: { zoneId: string; pngPath: string }[];
  submittedAt: string;
  canvasSize: 1024 | 2048 | 4096;
  phase: 'a' | 'b';
}

// In-memory heightmap store (keyed by projectId)
const heightmapStore = new Map<string, string>();

// In-memory painter session — only one project can be unlocked at a time
export interface PainterSession {
  projectId: string;
  phase: 'a' | 'b';
}
let activePainterSession: PainterSession | null = null;

export function unlockPainter(projectId: string, phase: 'a' | 'b'): void {
  activePainterSession = { projectId, phase };
}

export function lockPainter(): void {
  activePainterSession = null;
}

export function getPainterSession(): PainterSession | null {
  return activePainterSession;
}

function projectDir(projectId: string, base: string): string {
  return resolveStorageChild(base, requireStorageUuid(projectId, 'projectId'));
}

export async function submitZones(
  projectId: string,
  zones: Omit<Zone, 'maskPath'>[],
  masks: { zoneId: string; pngBase64: string }[],
  base = DEFAULT_PROJECTS_BASE,
  canvasSize: 1024 | 2048 | 4096 = 1024,
  phase: 'a' | 'b' = 'a',
): Promise<ZoneSession> {
  // Validate the complete request before the first filesystem mutation. A bad
  // name must not leave an empty project or masks directory behind.
  const safeMasks = masks.map((mask) => ({
    ...mask,
    zoneId: requireStorageFileStem(mask.zoneId, 'zoneId'),
  }));
  const masksDir = join(projectDir(projectId, base), 'masks');
  mkdirSync(masksDir, { recursive: true });
  const writtenMasks: { zoneId: string; pngPath: string }[] = [];

  for (const m of safeMasks) {
    const filename = `${m.zoneId}.png`;
    const pngPath = join(masksDir, filename);
    writeFileSync(pngPath, Buffer.from(m.pngBase64, 'base64'));
    writtenMasks.push({ zoneId: m.zoneId, pngPath });
  }

  const zonesWithPaths: Zone[] = zones.map((z) => ({
    ...z,
    maskPath: writtenMasks.find((m) => m.zoneId === z.id)?.pngPath ?? '',
  }));

  const session: ZoneSession = {
    projectId,
    zones: zonesWithPaths,
    masks: writtenMasks,
    submittedAt: new Date().toISOString(),
    canvasSize,
    phase,
  };

  writeFileSync(join(projectDir(projectId, base), 'zones.json'), JSON.stringify(session, null, 2), 'utf-8');

  return session;
}

export async function getCurrentZones(projectId: string, base = DEFAULT_PROJECTS_BASE): Promise<ZoneSession | null> {
  if (!isStorageUuid(projectId)) {
    requireStorageFileStem(projectId, 'projectId');
    return null;
  }
  const file = join(projectDir(projectId, base), 'zones.json');
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw);
  return parsed === null ? null : (parsed as ZoneSession);
}

// ── Scratch sessions ───────────────────────────────────────────────────────

const SCRATCH_SUBDIR = '.scratch';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function scratchSessionDir(scratchId: string, base: string): string {
  return resolveStorageChild(base, SCRATCH_SUBDIR, requireStorageUuid(scratchId, 'scratchSessionId'));
}

export function createScratchSession(
  base = DEFAULT_PROJECTS_BASE,
  ttlMs = DEFAULT_TTL_MS,
): { scratchSessionId: string } {
  const id = randomUUID();
  const dir = scratchSessionDir(id, base);
  mkdirSync(dir, { recursive: true });
  const meta = { createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return { scratchSessionId: id };
}

export async function submitScratchZones(
  scratchSessionId: string,
  zones: Omit<Zone, 'maskPath'>[],
  masks: { zoneId: string; pngBase64: string }[],
  base = DEFAULT_PROJECTS_BASE,
  canvasSize: 1024 | 2048 | 4096 = 1024,
): Promise<ZoneSession> {
  // Keep rejection atomic: validate every attacker-controlled filename before
  // creating the scratch session directory.
  const safeMasks = masks.map((mask) => ({
    ...mask,
    zoneId: requireStorageFileStem(mask.zoneId, 'zoneId'),
  }));
  const dir = scratchSessionDir(scratchSessionId, base);
  const masksDir = join(dir, 'masks');
  mkdirSync(masksDir, { recursive: true });
  const writtenMasks: { zoneId: string; pngPath: string }[] = [];

  for (const m of safeMasks) {
    const pngPath = join(masksDir, `${m.zoneId}.png`);
    writeFileSync(pngPath, Buffer.from(m.pngBase64, 'base64'));
    writtenMasks.push({ zoneId: m.zoneId, pngPath });
  }

  const zonesWithPaths: Zone[] = zones.map((z) => ({
    ...z,
    maskPath: writtenMasks.find((m) => m.zoneId === z.id)?.pngPath ?? '',
  }));

  const session: ZoneSession = {
    projectId: `scratch:${scratchSessionId}`,
    zones: zonesWithPaths,
    masks: writtenMasks,
    submittedAt: new Date().toISOString(),
    canvasSize,
    phase: 'a',
  };

  writeFileSync(join(dir, 'zones.json'), JSON.stringify(session, null, 2), 'utf-8');
  return session;
}

export async function getScratchZones(
  scratchSessionId: string,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ZoneSession | null> {
  if (!isStorageUuid(scratchSessionId)) {
    requireStorageFileStem(scratchSessionId, 'scratchSessionId');
    return null;
  }
  const file = join(scratchSessionDir(scratchSessionId, base), 'zones.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8')) as ZoneSession;
}

export function cleanupExpiredScratch(base = DEFAULT_PROJECTS_BASE): void {
  const scratchBase = join(base, SCRATCH_SUBDIR);
  if (!existsSync(scratchBase)) return;
  const now = Date.now();
  for (const entry of readdirSync(scratchBase)) {
    if (!isStorageUuid(entry)) continue;
    const metaPath = join(scratchBase, entry, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { expiresAt: number };
      if (meta.expiresAt < now) {
        rmSync(join(scratchBase, entry), { recursive: true, force: true });
      }
    } catch {
      /* skip corrupt entries */
    }
  }
}

export async function setHeightmap(
  projectId: string,
  heightmapPath: string,
  _base = DEFAULT_PROJECTS_BASE,
): Promise<void> {
  heightmapStore.set(projectId, heightmapPath);
}

export async function getHeightmap(projectId: string, _base = DEFAULT_PROJECTS_BASE): Promise<string | null> {
  return heightmapStore.get(projectId) ?? null;
}
