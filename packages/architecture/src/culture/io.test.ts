import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCulture, readCulture, listCultures, deleteCulture } from './io.js';
import { seedCulture } from './presets.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'culture-')); });

describe('culture io', () => {
  it('writes three files and reads identical culture back', async () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    await writeCulture(root, c);
    const back = await readCulture(root, 'foo');
    expect(back).toEqual(c);
  });

  it('listCultures returns ids with era counts', async () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    await writeCulture(root, c);
    const list = await listCultures(root);
    expect(list).toEqual([{ id: 'foo', name: 'Foo', eraCount: 0 }]);
  });

  it('deleteCulture removes the directory', async () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    await writeCulture(root, c);
    await deleteCulture(root, 'foo');
    expect(await listCultures(root)).toEqual([]);
  });

  it('writes JSON with 2-space indent and stable key ordering', async () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    await writeCulture(root, c);
    const raw = await readFile(join(root, 'foo', 'culture.json'), 'utf8');
    expect(raw.startsWith('{\n  "')).toBe(true);
    // Round-trip: write same object twice; bytes must match.
    await writeCulture(root, c);
    const raw2 = await readFile(join(root, 'foo', 'culture.json'), 'utf8');
    expect(raw2).toBe(raw);
  });

  it('culture.json contains a {id,name} index for materials and ornaments, not full entries', async () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    await writeCulture(root, c);
    const structural = JSON.parse(await readFile(join(root, 'foo', 'culture.json'), 'utf8'));
    expect(structural.materials.every((m: any) => Object.keys(m).sort().join(',') === 'id,name')).toBe(true);
    expect(structural.ornaments.every((o: any) => Object.keys(o).sort().join(',') === 'id,name')).toBe(true);
  });
});
