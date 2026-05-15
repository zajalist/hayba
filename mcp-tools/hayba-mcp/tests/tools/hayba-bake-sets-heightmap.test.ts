import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bakeTerrain } from '../../src/tools/hayba-bake-terrain.js';
import type { SessionManager } from '../../src/gaea/session.js';

function makeSession(overrides: Partial<SessionManager> = {}): SessionManager {
  return {
    terrainPath: '/tmp/test.terrain',
    lastBakedHeightmap: null,
    outputDir: '/tmp/out',
    gaeaExePath: '',
    gaeaPid: null,
    setTerrainPath: vi.fn(),
    saveGaeaSession: vi.fn(),
    clearGaeaSession: vi.fn(),
    enqueue: vi.fn((fn: () => Promise<unknown>) => fn()),
    client: {
      loadGraph: vi.fn().mockResolvedValue(undefined),
      cook: vi.fn().mockResolvedValue(undefined),
      export: vi.fn().mockResolvedValue({
        heightmap: '/tmp/out/terrain.r16',
        normalmap: undefined,
        splatmap: undefined,
      }),
    } as unknown as SessionManager['client'],
    ...overrides,
  } as unknown as SessionManager;
}

describe('bakeTerrain sets lastBakedHeightmap', () => {
  it('sets session.lastBakedHeightmap to the exported heightmap path', async () => {
    const session = makeSession();
    await bakeTerrain({ path: '/tmp/test.terrain' }, session);
    expect(session.lastBakedHeightmap).toBe('/tmp/out/terrain.r16');
  });

  it('does not set lastBakedHeightmap when export fails', async () => {
    const session = makeSession({
      client: {
        loadGraph: vi.fn().mockResolvedValue(undefined),
        cook: vi.fn().mockResolvedValue(undefined),
        export: vi.fn().mockRejectedValue(new Error('export failed')),
      } as unknown as SessionManager['client'],
    });
    await bakeTerrain({ path: '/tmp/test.terrain' }, session);
    expect(session.lastBakedHeightmap).toBeNull();
  });
});
