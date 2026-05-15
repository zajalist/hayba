import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setPainterHeightmapHandler } from '../../src/tools/hayba-set-painter-heightmap.js';
import { createProject } from '../../src/projects.js';
import { getHeightmap } from '../../src/zones.js';

const TEST_BASE = join(homedir(), '.hayba', 'projects-sph-test-' + Date.now());

describe('hayba_set_painter_heightmap', () => {
  afterEach(() => {
    if (existsSync(TEST_BASE)) rmSync(TEST_BASE, { recursive: true, force: true });
  });

  it('stores heightmap path', async () => {
    const p = await createProject('Test', TEST_BASE);
    const result = await setPainterHeightmapHandler({ projectId: p.id, heightmapPath: '/tmp/terrain.r16' }, TEST_BASE);
    expect(result.isError).toBeFalsy();
    const stored = await getHeightmap(p.id, TEST_BASE);
    expect(stored).toBe('/tmp/terrain.r16');
  });

  it('returns error when projectId is missing', async () => {
    const result = await setPainterHeightmapHandler({ heightmapPath: '/tmp/x.r16' }, TEST_BASE);
    expect(result.isError).toBe(true);
  });

  it('returns error when heightmapPath is missing', async () => {
    const p = await createProject('Test', TEST_BASE);
    const result = await setPainterHeightmapHandler({ projectId: p.id }, TEST_BASE);
    expect(result.isError).toBe(true);
  });
});
