import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecipeLoader } from './loader.js';

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

describe('RecipeLoader', () => {
  let userDir: string;
  let bundledDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-recipe-user-'));
    bundledDir = mkdtempSync(join(tmpdir(), 'hayba-recipe-bundled-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(bundledDir, { recursive: true, force: true });
  });

  it('loads valid specs from userDir', async () => {
    writeFileSync(join(userDir, 'com.test.demo.recipe.json'), JSON.stringify(validSpec));
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.list().map(s => s.id)).toEqual(['com.test.demo']);
    expect(loader.get('com.test.demo')?.title).toBe('Demo');
  });

  it('seeds userDir from bundledDir on first reload if userDir lacks the spec', async () => {
    writeFileSync(join(bundledDir, 'com.test.demo.recipe.json'), JSON.stringify(validSpec));
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    expect(existsSync(join(userDir, 'com.test.demo.recipe.json'))).toBe(true);
    expect(loader.get('com.test.demo')).toBeDefined();
  });

  it('re-seeds from bundledDir when the bundled spec version differs from the installed copy', async () => {
    writeFileSync(join(userDir, 'com.test.demo.recipe.json'),
      JSON.stringify({ ...validSpec, version: '1.0.0', title: 'Old' }));
    writeFileSync(join(bundledDir, 'com.test.demo.recipe.json'),
      JSON.stringify({ ...validSpec, version: '1.1.0', title: 'New' }));
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.get('com.test.demo')?.title).toBe('New');
  });

  it('userDir wins over bundledDir when both have the same id', async () => {
    writeFileSync(join(bundledDir, 'com.test.demo.recipe.json'), JSON.stringify(validSpec));
    writeFileSync(join(userDir, 'com.test.demo.recipe.json'), JSON.stringify({ ...validSpec, title: 'User Override' }));
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.get('com.test.demo')?.title).toBe('User Override');
  });

  it('skips and logs invalid specs without failing the whole reload', async () => {
    writeFileSync(join(userDir, 'good.recipe.json'), JSON.stringify(validSpec));
    writeFileSync(join(userDir, 'bad.recipe.json'), '{ not valid json');
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.list().length).toBe(1);
    expect(loader.errors().length).toBe(1);
    expect(loader.errors()[0]).toMatch(/bad\.recipe\.json/);
  });

  it('lists a half-migrated recipe once, preferring the current spelling', () => {
    // A real library mid-rename holds both spellings of the same recipe.
    // Without a rule the map keeps whichever readdir returned last, which is
    // nobody's decision.
    writeFileSync(join(userDir, 'com.test.demo.sliver.json'),
      JSON.stringify({ ...validSpec, title: 'Old Name' }));
    writeFileSync(join(userDir, 'com.test.demo.recipe.json'),
      JSON.stringify({ ...validSpec, title: 'Current Name' }));

    const loader = new RecipeLoader({ userDir, bundledDir });
    loader.reload();

    expect(loader.list().length).toBe(1);
    expect(loader.list()[0]!.title).toBe('Current Name');
  });

  it('still loads specs named the old way', () => {
    // Recipes were called slivers. A user upgrading has a directory full of
    // *.sliver.json and must not find their recipes gone.
    writeFileSync(join(userDir, 'com.test.demo.sliver.json'), JSON.stringify(validSpec));

    const loader = new RecipeLoader({ userDir, bundledDir });
    loader.reload();

    expect(loader.list().length).toBe(1);
    expect(loader.errors()).toEqual([]);
  });

  it('install writes a spec to userDir and adds it to the in-memory map', async () => {
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    const r = loader.install(validSpec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe('com.test.demo');
    expect(existsSync(join(userDir, 'com.test.demo.recipe.json'))).toBe(true);
    expect(loader.get('com.test.demo')).toBeDefined();
  });

  it('install rejects malformed specs', async () => {
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    const r = loader.install({ ...validSpec, id: 'not-reverse-dns' });
    expect(r.ok).toBe(false);
  });

  it('ignores non-recipe json files', async () => {
    writeFileSync(join(userDir, 'com.test.demo.preset.json'), JSON.stringify({ distance: 5 }));
    writeFileSync(join(userDir, 'README.md'), '# recipes');
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.list()).toEqual([]);
  });
});

describe('the on-disk library location', () => {
  it('is the directory the plugin also reads', async () => {
    // HaybaSliverLoader.h scans %APPDATA%/Hayba/slivers. If this ever moves
    // without the plugin moving with it, both halves point at different
    // directories and the user's Recipes panel goes empty -- which is exactly
    // what a blanket rename did before this test existed.
    const { defaultUserRecipesDir } = await import('./loader.js');
    expect(defaultUserRecipesDir().replace(/\\/g, '/')).toMatch(/\/Hayba\/slivers$/);
  });
});
