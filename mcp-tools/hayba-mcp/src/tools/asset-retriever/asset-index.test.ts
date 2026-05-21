import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetIndex } from './asset-index.js';
import type { AssetDoc } from './types.js';

const docs: AssetDoc[] = [
  { path: '/Game/Foo/SM_PineTree', name: 'SM_PineTree', class: 'StaticMesh', tags: ['tree', 'pine'], source: 'project', lastModified: 1 },
  { path: '/Game/Foo/SM_OakTree', name: 'SM_OakTree', class: 'StaticMesh', tags: ['tree', 'oak'], source: 'project', lastModified: 1 },
  { path: '/Game/Foo/M_Rock', name: 'M_Rock', class: 'Material', tags: ['rock'], source: 'project', lastModified: 1 },
];

class FakeEmb {
  id = 'fake';
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => {
      if (/tree|pine|oak/i.test(t)) return new Float32Array([1, 0, 0]);
      if (/rock/i.test(t))          return new Float32Array([0, 1, 0]);
      return new Float32Array([0, 0, 1]);
    });
  }
}

describe('AssetIndex BM25', () => {
  it('ranks exact-token matches', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: null });
    const hits = await idx.search('pine tree');
    expect(hits[0].path).toBe('/Game/Foo/SM_PineTree');
  });

  it('filterClass restricts results', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: null });
    const hits = await idx.search('rock', { filterClass: 'StaticMesh' });
    expect(hits.find(h => h.path === '/Game/Foo/M_Rock')).toBeUndefined();
  });

  it('filterSource restricts results', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: null });
    const hits = await idx.search('tree', { filterSource: 'polyhaven' });
    expect(hits).toEqual([]);
  });
});

describe('AssetIndex hybrid', () => {
  it('embedding hit surfaces semantic match for tree query', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: new FakeEmb() });
    const hits = await idx.search('pine', { k: 3 });
    expect(hits.some(h => h.path === '/Game/Foo/SM_OakTree')).toBe(true);
  });
});

describe('AssetIndex cache', () => {
  it('cache files written + corruption recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ai-'));
    try {
      const a = await AssetIndex.build(docs, { embeddings: null, cacheDir: dir });
      expect(existsSync(join(dir, 'asset-index.meta.json'))).toBe(true);
      expect(existsSync(join(dir, 'asset-index.bm25.json'))).toBe(true);

      const b = await AssetIndex.build(docs, { embeddings: null, cacheDir: dir });
      expect((await b.search('pine')).map(h => h.path)).toEqual(
        (await a.search('pine')).map(h => h.path),
      );

      writeFileSync(join(dir, 'asset-index.meta.json'), '{not json');
      const c = await AssetIndex.build(docs, { embeddings: null, cacheDir: dir });
      expect((await c.search('pine'))[0]?.path).toBe('/Game/Foo/SM_PineTree');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AssetIndex delta', () => {
  it('addOrUpdate merges new docs', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: null });
    const newDoc: AssetDoc = { path: '/Game/Foo/SM_BirchTree', name: 'SM_BirchTree', class: 'StaticMesh', tags: ['tree', 'birch'], source: 'project', lastModified: 2 };
    await idx.addOrUpdate([newDoc]);
    const hits = await idx.search('birch');
    expect(hits[0]?.path).toBe('/Game/Foo/SM_BirchTree');
  });

  it('addOrUpdate replaces existing path', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: null });
    const updated: AssetDoc = { ...docs[0], tags: ['tree', 'pine', 'tall'] };
    await idx.addOrUpdate([updated]);
    const hits = await idx.search('tall');
    expect(hits[0]?.path).toBe('/Game/Foo/SM_PineTree');
  });
});
