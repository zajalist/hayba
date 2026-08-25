import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupRecipeSystem } from '../../recipes/index.js';
import { recipeListHandler } from './list.js';

describe('hayba_sliver_list', () => {
  let userDir: string;
  let sys: Awaited<ReturnType<typeof setupRecipeSystem>>;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-list-'));
    sys = await setupRecipeSystem({ userDir, bundledDir: 'src/recipes/specs', maxDepth: 4 });
    // Starters are no longer installed at boot -- the IA makes seeding
    // the user's choice -- so a test that needs one in the library asks.
    await sys.loader.seedStarterRecipes();
  });
  afterEach(() => { rmSync(userDir, { recursive: true, force: true }); });

  it('returns all installed recipes', async () => {
    const r = await recipeListHandler({}, { loader: sys.loader });
    expect(r.recipes.length).toBeGreaterThan(0);
    expect(r.recipes[0]).toMatchObject({
      id: 'com.hayba.composition.frame_target',
      category: 'composition',
    });
  });

  it('filters by category', async () => {
    const r = await recipeListHandler({ category: 'composition' }, { loader: sys.loader });
    expect(r.recipes.every(s => s.category === 'composition')).toBe(true);
    const empty = await recipeListHandler({ category: 'does_not_exist' }, { loader: sys.loader });
    expect(empty.recipes).toEqual([]);
  });

  it('filters by namespace prefix', async () => {
    const r = await recipeListHandler({ namespace: 'com.hayba' }, { loader: sys.loader });
    expect(r.recipes.every(s => s.id.startsWith('com.hayba.'))).toBe(true);
  });
});
