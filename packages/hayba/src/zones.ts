import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PROJECTS_BASE } from './projects.js';

export interface Zone {
  id: string;
  name: string;
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
  return join(base, projectId);
}

export async function submitZones(
  projectId: string,
  zones: Omit<Zone, 'maskPath'>[],
  masks: { zoneId: string; pngBase64: string }[],
  base = DEFAULT_PROJECTS_BASE,
  canvasSize: 1024 | 2048 | 4096 = 1024,
  phase: 'a' | 'b' = 'a',
): Promise<ZoneSession> {
  const masksDir = join(projectDir(projectId, base), 'masks');
  const writtenMasks: { zoneId: string; pngPath: string }[] = [];

  for (const m of masks) {
    const filename = `${m.zoneId}.png`;
    const pngPath = join(masksDir, filename);
    writeFileSync(pngPath, Buffer.from(m.pngBase64, 'base64'));
    writtenMasks.push({ zoneId: m.zoneId, pngPath });
  }

  const zonesWithPaths: Zone[] = zones.map(z => ({
    ...z,
    maskPath: writtenMasks.find(m => m.zoneId === z.id)?.pngPath ?? '',
  }));

  const session: ZoneSession = {
    projectId,
    zones: zonesWithPaths,
    masks: writtenMasks,
    submittedAt: new Date().toISOString(),
    canvasSize,
    phase,
  };

  writeFileSync(
    join(projectDir(projectId, base), 'zones.json'),
    JSON.stringify(session, null, 2),
    'utf-8',
  );

  return session;
}

export async function getCurrentZones(
  projectId: string,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ZoneSession | null> {
  const file = join(projectDir(projectId, base), 'zones.json');
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw);
  return parsed === null ? null : (parsed as ZoneSession);
}

export async function setHeightmap(
  projectId: string,
  heightmapPath: string,
  _base = DEFAULT_PROJECTS_BASE,
): Promise<void> {
  heightmapStore.set(projectId, heightmapPath);
}

export async function getHeightmap(
  projectId: string,
  _base = DEFAULT_PROJECTS_BASE,
): Promise<string | null> {
  return heightmapStore.get(projectId) ?? null;
}
