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

  // This used to assert that reload() seeded the user's library from the
  // bundled specs. That is the behaviour the IA rules out -- "the optional
  // seed choice must be explicit" -- and it also meant the teaching empty
  // state a fresh install should show could never appear, because the library
  // filled itself before anyone looked at it.
  it('does NOT install bundled starters on reload', async () => {
    writeFileSync(join(bundledDir, 'com.test.demo.recipe.json'), JSON.stringify(validSpec));
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    expect(existsSync(join(userDir, 'com.test.demo.recipe.json'))).toBe(false);
    expect(loader.list()).toEqual([]);
  });

  it('offers the bundled starters the user does not have', async () => {
    writeFileSync(join(bundledDir, 'com.test.demo.recipe.json'), JSON.stringify(validSpec));
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.availableStarters()).toEqual(['com.test.demo.recipe.json']);
  });

  it('installs starters when asked, and only then', async () => {
    writeFileSync(join(bundledDir, 'com.test.demo.recipe.json'), JSON.stringify(validSpec));
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.list()).toEqual([]);

    const installed = await loader.seedStarterRecipes();
    expect(installed).toEqual(['com.test.demo.recipe.json']);
    expect(loader.get('com.test.demo')).toBeDefined();
    // Nothing left to offer once they are in.
    expect(loader.availableStarters()).toEqual([]);
  });

  it('a starter the user deleted stays deleted', async () => {
    // The old combined method reinstalled it on the next launch, which reads
    // as the library ignoring the user.
    writeFileSync(join(bundledDir, 'com.test.demo.recipe.json'), JSON.stringify(validSpec));
    const loader = new RecipeLoader({ userDir, bundledDir });
    await loader.seedStarterRecipes();
    expect(loader.get('com.test.demo')).toBeDefined();

    rmSync(join(userDir, 'com.test.demo.recipe.json'));
    await loader.reload();
    expect(loader.get('com.test.demo')).toBeUndefined();
    expect(existsSync(join(userDir, 'com.test.demo.recipe.json'))).toBe(false);
  });

  it('seeding does not overwrite a starter the user has edited', async () => {
    writeFileSync(join(bundledDir, 'com.test.demo.recipe.json'), JSON.stringify(validSpec));
    writeFileSync(join(userDir, 'com.test.demo.recipe.json'),
      JSON.stringify({ ...validSpec, title: 'Mine' }));
    const loader = new RecipeLoader({ userDir, bundledDir });

    const installed = await loader.seedStarterRecipes();
    expect(installed).toEqual([]);
    await loader.reload();
    expect(loader.get('com.test.demo')?.title).toBe('Mine');
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
    // HaybaRecipeLoader::DefaultUserRecipesDir returns the same path. If these
    // two ever disagree, both halves point at different directories and the
    // user's Recipes panel goes empty -- which is what a blanket rename did
    // before this test existed.
    const { defaultUserRecipesDir } = await import('./loader.js');
    expect(defaultUserRecipesDir().replace(/\\/g, '/')).toMatch(/\/Hayba\/recipes$/);
  });

  it('knows where the library used to live', async () => {
    const { legacyUserRecipesDir } = await import('./loader.js');
    expect(legacyUserRecipesDir().replace(/\\/g, '/')).toMatch(/\/Hayba\/slivers$/);
  });
});

describe('moving a pre-rename library', () => {
  let root: string;
  let legacyDir: string;
  let bundled: string;

  const spec = (over: Record<string, unknown> = {}) => JSON.stringify({
    id: 'com.test.demo', version: '1.0.0', category: 'test', title: 'Demo',
    description: '', author: 'test', params: [], executor: { kind: 'test.kind' },
    determinism: { pure: true, declared_outputs: [], side_effects: [], reads: [], seed_param: null },
    ...over,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hayba-recipe-move-'));
    legacyDir = join(root, 'slivers');
    bundled = join(root, 'bundled');
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(bundled, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('moves the whole directory when the new one does not exist yet', async () => {
    const { migrateLegacyLibrary } = await import('./loader.js');
    writeFileSync(join(legacyDir, 'com.test.demo.sliver.json'), spec());
    const target = join(root, 'recipes');

    expect(migrateLegacyLibrary(legacyDir, target).moved).toBe(true);

    // Moved, not copied: two live libraries would drift the moment either was
    // edited, and nothing would say which one counted.
    expect(existsSync(legacyDir)).toBe(false);
    const loader = new RecipeLoader({ userDir: target, bundledDir: bundled });
    loader.reload();
    expect(loader.list().length).toBe(1);
  });

  it('fills in a partly-migrated library without overwriting', async () => {
    const { migrateLegacyLibrary } = await import('./loader.js');
    const target = join(root, 'recipes');
    mkdirSync(target, { recursive: true });
    // Already migrated, and edited since.
    writeFileSync(join(target, 'com.test.demo.recipe.json'), spec({ title: 'Edited Since' }));
    // Still sitting in the old directory.
    writeFileSync(join(legacyDir, 'com.test.demo.recipe.json'), spec({ title: 'Stale' }));
    writeFileSync(join(legacyDir, 'com.test.other.recipe.json'), spec({ id: 'com.test.other' }));

    expect(migrateLegacyLibrary(legacyDir, target).moved).toBe(true);

    const loader = new RecipeLoader({ userDir: target, bundledDir: bundled });
    loader.reload();
    // The edited copy wins; the stale one must not clobber it.
    expect(loader.get('com.test.demo')?.title).toBe('Edited Since');
    expect(loader.get('com.test.other')).toBeDefined();
  });

  it('does nothing when there is no old library', async () => {
    const { migrateLegacyLibrary } = await import('./loader.js');
    const target = join(root, 'recipes');

    expect(migrateLegacyLibrary(join(root, 'nope'), target).moved).toBe(false);
    expect(existsSync(target)).toBe(false);
  });
});
