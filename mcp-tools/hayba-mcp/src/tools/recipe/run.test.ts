// mcp-tools/hayba-mcp/src/tools/recipe/run.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupRecipeSystem } from '../../recipes/index.js';
import { recipeRunHandler } from './run.js';

describe('hayba_sliver_run', () => {
  let userDir: string;
  let sys: Awaited<ReturnType<typeof setupRecipeSystem>>;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-run-'));
    sys = await setupRecipeSystem({ userDir, bundledDir: 'src/recipes/specs', maxDepth: 4 });
  });
  afterEach(() => { rmSync(userDir, { recursive: true, force: true }); });

  it('executes a known recipe and returns ok=true with outputs', async () => {
    const r = await recipeRunHandler(
      { id: 'com.hayba.composition.frame_target', params: { target: '/Game/X.X' } },
      { runtime: sys.runtime },
    );
    expect(r.ok).toBe(true);
    expect(r.outputs).toHaveProperty('camera_transform');
    expect(typeof r.durationMs).toBe('number');
  });

  it('returns ok=false with error message when recipe id is unknown', async () => {
    const r = await recipeRunHandler(
      { id: 'com.nope.missing', params: {} },
      { runtime: sys.runtime },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing/);
  });

  it('returns ok=false when params fail validation', async () => {
    const r = await recipeRunHandler(
      { id: 'com.hayba.composition.frame_target', params: { target: '/Game/X.X', distance: 9999 } },
      { runtime: sys.runtime },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/distance/);
  });
});
