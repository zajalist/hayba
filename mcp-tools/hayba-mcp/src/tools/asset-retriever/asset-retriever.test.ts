import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRetriever } from './asset-retriever.js';

function makeDispatch(initial: Array<{ path: string; name?: string; class?: string; tags?: string[]; lastModified?: number }>) {
  const assets = [...initial];
  const fn = vi.fn(async (cmd: string, args?: { paths?: string[]; path?: string }) => {
    if (cmd === 'describe_assets') {
      if (args?.paths) return { assets: assets.filter(a => args.paths!.includes(a.path)) };
      return { assets };
    }
    return {};
  });
  return { fn, push: (a: { path: string; name?: string; class?: string; tags?: string[]; lastModified?: number }) => assets.push(a) };
}

describe('AssetRetriever', () => {
  it('lazy build — no fetch until first search', async () => {
    const { fn } = makeDispatch([{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 1 }]);
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ar-'));
    try {
      const ar = new AssetRetriever(fn, { cacheDir: dir, embeddings: null });
      expect(fn).not.toHaveBeenCalled();
      await ar.search('a');
      expect(fn).toHaveBeenCalledWith('describe_assets', { path: '/Game/' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reindex forces fresh fetch', async () => {
    const { fn, push } = makeDispatch([{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 1 }]);
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ar-'));
    try {
      const ar = new AssetRetriever(fn, { cacheDir: dir, embeddings: null });
      await ar.search('a');
      push({ path: '/Game/B', name: 'B', class: 'X', tags: [], lastModified: 2 });
      const r = await ar.reindex();
      expect(r.docCount).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('markDeltaStale triggers delta-merge on next search', async () => {
    const { fn, push } = makeDispatch([{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 1 }]);
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ar-'));
    try {
      const ar = new AssetRetriever(fn, { cacheDir: dir, embeddings: null });
      await ar.search('a');
      push({ path: '/Game/B', name: 'B', class: 'X', tags: ['birch'], lastModified: 2 });
      ar.markDeltaStale(['/Game/B']);
      const hits = await ar.search('birch');
      expect(hits.some(h => h.path === '/Game/B')).toBe(true);
      void fn;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('browse triggers lazy build too', async () => {
    const { fn } = makeDispatch([{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 1 }]);
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ar-'));
    try {
      const ar = new AssetRetriever(fn, { cacheDir: dir, embeddings: null });
      const page = await ar.browse({}, 0, 50);
      expect(page.total).toBe(1);
      expect(fn).toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
