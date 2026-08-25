import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecipeLoader } from '../../recipes/loader.js';
import { recipeStartersHandler } from './starters.js';

/**
 * The starters tool is how the IA's "optional seed choice" gets made now that
 * the loader no longer installs anything by itself.
 *
 * The behaviour worth pinning is that listing and installing are separate: a
 * caller must be able to show what is on offer without committing the user to
 * it. A tool that installed as a side effect of being asked "what is
 * available?" would reintroduce exactly what this replaced.
 */

// Copied from loader.test.ts rather than invented: my first version omitted
// author and used a determinism shape parseRecipeSpec rejects, so every spec
// was skipped on load and three tests failed for a reason that had nothing to
// do with what they were testing.
const validSpec = {
  id: 'com.test.demo',
  version: '1.0.0',
  category: 'test',
  title: 'Demo',
  description: '',
  author: 'test',
  params: [],
  executor: { kind: 'test.demo' },
  determinism: { pure: true, declared_outputs: [], side_effects: [], seed_param: null },
};

describe('hayba_recipe_starters', () => {
  let root: string, userDir: string, bundledDir: string, loader: RecipeLoader;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hayba-starters-'));
    userDir = join(root, 'user');
    bundledDir = join(root, 'bundled');
    mkdirSync(userDir, { recursive: true });
    mkdirSync(bundledDir, { recursive: true });
    writeFileSync(join(bundledDir, 'com.test.demo.recipe.json'), JSON.stringify(validSpec));
    loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lists what is on offer without installing it', async () => {
    const r = await recipeStartersHandler({}, { loader });
    expect(r.available).toEqual(['com.test.demo.recipe.json']);
    expect(r.installed).toEqual([]);
    // The whole point: asking what is available must not be the act of
    // accepting it.
    expect(loader.list()).toEqual([]);
  });

  it('installs only when asked', async () => {
    const r = await recipeStartersHandler({ install: true }, { loader });
    expect(r.installed).toEqual(['com.test.demo.recipe.json']);
    expect(r.available).toEqual([]);
    expect(loader.get('com.test.demo')).toBeDefined();
  });

  it('is safe to run twice', async () => {
    await recipeStartersHandler({ install: true }, { loader });
    const second = await recipeStartersHandler({ install: true }, { loader });
    expect(second.installed).toEqual([]);
    expect(loader.list().length).toBe(1);
  });

  it('distinguishes "none shipped" from "you have them all"', async () => {
    // Different facts, and a caller says different things about them: one is
    // "there are no starters", the other is "your Library is already seeded".
    const empty = mkdtempSync(join(tmpdir(), 'hayba-nobundle-'));
    const bare = new RecipeLoader({ userDir: join(empty, 'u'), bundledDir: join(empty, 'b') });
    await bare.reload();
    const none = await recipeStartersHandler({}, { loader: bare });
    expect(none.none_bundled).toBe(true);

    await recipeStartersHandler({ install: true }, { loader });
    const seeded = await recipeStartersHandler({}, { loader });
    expect(seeded.available).toEqual([]);
    expect(seeded.none_bundled).toBe(false);

    rmSync(empty, { recursive: true, force: true });
  });
});
