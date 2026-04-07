import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { importLandscapeHandler } from '../../src/tools/hayba-import-landscape.js';
import type { SessionManager } from '../../src/gaea/session.js';

// Mock tcp-client so tests don't need a real UE connection
vi.mock('../../src/tcp-client.js', () => ({
  ensureConnected: vi.fn(),
}));

import { ensureConnected } from '../../src/tcp-client.js';

const GLOBAL_DIR = join(homedir(), '.hayba');
const GLOBAL_PATH = join(GLOBAL_DIR, 'conventions.json');

function makeSession(overrides: Partial<{ terrainPath: string | null; lastBakedHeightmap: string | null }> = {}): SessionManager {
  return {
    terrainPath: null,
    lastBakedHeightmap: null,
    outputDir: '/tmp/out',
    ...overrides,
  } as unknown as SessionManager;
}

function makeMockClient(response: { ok: boolean; data?: Record<string, unknown>; error?: string }) {
  return { send: vi.fn().mockResolvedValue({ id: 'req_1', ...response }) };
}

function writeGlobalConventions(landscapeMaterials: string) {
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(GLOBAL_PATH, JSON.stringify({
    version: 1,
    preset: 'epic-default',
    folders: { pcgGraphs: '/Game/PCG', landscapeMaterials, heightmaps: '/Game/Terrain', blueprints: '/Game/BP', textures: '/Game/Textures' },
    naming: { pcgGraphPrefix: 'PCG_', materialPrefix: 'M_', blueprintPrefix: 'BP_', texturePrefix: 'T_', folderCasing: 'PascalCase' },
    workflow: { confirmBeforeOverwrite: true, preferredLandscapeResolution: 1009, defaultHeightmapFormat: 'r16', autoOpenInGaeaAfterBake: false },
  }), 'utf-8');
}

function cleanupGlobal() {
  if (existsSync(GLOBAL_DIR)) rmSync(GLOBAL_DIR, { recursive: true, force: true });
}

describe('hayba_import_landscape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanupGlobal();
  });

  afterEach(() => {
    cleanupGlobal();
  });

  it('returns error when no heightmapPath and no lastBakedHeightmap', async () => {
    const result = await importLandscapeHandler({}, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('no heightmap');
  });

  it('uses session.lastBakedHeightmap when heightmapPath omitted', async () => {
    writeGlobalConventions('/Game/Materials/Landscape');
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as never);

    const session = makeSession({ lastBakedHeightmap: '/tmp/out/terrain.r16' });
    await importLandscapeHandler({}, session);

    expect(mockClient.send).toHaveBeenCalledWith(
      'import_landscape',
      expect.objectContaining({ heightmapPath: '/tmp/out/terrain.r16' }),
      expect.any(Number)
    );
  });

  it('uses provided heightmapPath over session path', async () => {
    writeGlobalConventions('/Game/Materials/Landscape');
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as never);

    const session = makeSession({ lastBakedHeightmap: '/tmp/old.r16' });
    await importLandscapeHandler({ heightmapPath: '/tmp/explicit.r16' }, session);

    expect(mockClient.send).toHaveBeenCalledWith(
      'import_landscape',
      expect.objectContaining({ heightmapPath: '/tmp/explicit.r16' }),
      expect.any(Number)
    );
  });

  it('resolves material from conventions when landscapeMaterial omitted', async () => {
    writeGlobalConventions('/Game/Materials/Landscape/M_Terrain');
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as never);

    await importLandscapeHandler({ heightmapPath: '/tmp/terrain.r16' }, makeSession());

    expect(mockClient.send).toHaveBeenCalledWith(
      'import_landscape',
      expect.objectContaining({ landscapeMaterial: '/Game/Materials/Landscape/M_Terrain' }),
      expect.any(Number)
    );
  });

  it('returns prompt message when no landscapeMaterial and no conventions', async () => {
    const result = await importLandscapeHandler({ heightmapPath: '/tmp/terrain.r16' }, makeSession());
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('landscapeMaterial');
  });

  it('sends empty landscapeMaterial string when explicitly passed as empty', async () => {
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as never);

    await importLandscapeHandler({ heightmapPath: '/tmp/terrain.r16', landscapeMaterial: '' }, makeSession());

    expect(mockClient.send).toHaveBeenCalledWith(
      'import_landscape',
      expect.objectContaining({ landscapeMaterial: '' }),
      expect.any(Number)
    );
  });

  it('sends default worldSizeKm and maxHeightM when not provided', async () => {
    writeGlobalConventions('/Game/Materials/Landscape');
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as never);

    await importLandscapeHandler({ heightmapPath: '/tmp/terrain.r16' }, makeSession());

    expect(mockClient.send).toHaveBeenCalledWith(
      'import_landscape',
      expect.objectContaining({ worldSizeKm: 8.0, maxHeightM: 600.0 }),
      expect.any(Number)
    );
  });

  it('returns isError true when TCP responds with error', async () => {
    writeGlobalConventions('/Game/Materials/Landscape');
    const mockClient = makeMockClient({ ok: false, error: 'Heightmap not found' });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as never);

    const result = await importLandscapeHandler({ heightmapPath: '/tmp/missing.r16' }, makeSession());

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Heightmap not found');
  });

  it('returns actor label and scale values on success', async () => {
    writeGlobalConventions('/Game/Materials/Landscape');
    const mockClient = makeMockClient({ ok: true, data: { actorLabel: 'Hayba_Terrain', scaleXY: 97.7, scaleZ: 117.2 } });
    vi.mocked(ensureConnected).mockResolvedValue(mockClient as never);

    const result = await importLandscapeHandler({ heightmapPath: '/tmp/terrain.r16' }, makeSession());

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Hayba_Terrain');
  });
});
