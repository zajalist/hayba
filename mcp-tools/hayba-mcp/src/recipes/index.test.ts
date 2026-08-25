import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupRecipeSystem } from './index.js';

describe('setupRecipeSystem', () => {
  let userDir: string;
  let bundledDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-recipe-sys-u-'));
    bundledDir = mkdtempSync(join(tmpdir(), 'hayba-recipe-sys-b-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(bundledDir, { recursive: true, force: true });
  });

  it('wires loader + registry + runtime and registers built-in executors', async () => {
    const sys = await setupRecipeSystem({ userDir, bundledDir, maxDepth: 4 });
    expect(sys.registry.kinds()).toContain('composition.frame_target');
    expect(sys.runtime).toBeDefined();
    expect(sys.loader).toBeDefined();
  });

  it('installs the bundled frame_target spec only when asked, then runs it', async () => {
    const { copyFileSync, mkdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    mkdirSync(bundledDir, { recursive: true });
    copyFileSync(
      resolve('src/recipes/specs/com.hayba.composition.frame_target.recipe.json'),
      join(bundledDir, 'com.hayba.composition.frame_target.recipe.json'),
    );
    const sys = await setupRecipeSystem({ userDir, bundledDir, maxDepth: 4 });
    // Boot does NOT install starters any more -- "the optional seed choice
    // must be explicit" -- so the library is empty until asked.
    expect(sys.loader.get('com.hayba.composition.frame_target')).toBeUndefined();

    await sys.loader.seedStarterRecipes();
    expect(sys.loader.get('com.hayba.composition.frame_target')).toBeDefined();

    const r = await sys.runtime.runRecipe('com.hayba.composition.frame_target', { target: '/Game/X.X' });
    expect(r.ok).toBe(true);
    expect(r.outputs).toHaveProperty('camera_transform');
  });
});
