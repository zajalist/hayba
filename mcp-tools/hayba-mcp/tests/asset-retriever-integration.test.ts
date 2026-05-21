import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRetriever } from '../src/tools/asset-retriever/asset-retriever.js';

describe('asset-retriever integration', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hayba-arint-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('end-to-end search → download → delta → search-includes-new', async () => {
    const initialAssets = [
      { path: '/Game/A/SM_PineTree', name: 'SM_PineTree', class: 'StaticMesh', tags: ['tree', 'pine'], lastModified: 1 },
      { path: '/Game/A/SM_OakTree',  name: 'SM_OakTree',  class: 'StaticMesh', tags: ['tree', 'oak'],  lastModified: 1 },
    ];
    const current = [...initialAssets];
    const dispatch = vi.fn(async (cmd: string, args?: { paths?: string[] }) => {
      if (cmd === 'describe_assets') {
        if (args?.paths) return { assets: current.filter(a => args.paths!.includes(a.path)) };
        return { assets: current };
      }
      return {};
    });

    const ar = new AssetRetriever(dispatch, { cacheDir: dir, embeddings: null });

    const hits1 = await ar.search('pine', { k: 5 });
    expect(hits1[0].path).toBe('/Game/A/SM_PineTree');

    current.push({ path: '/Game/A/SM_Birch', name: 'SM_Birch', class: 'StaticMesh', tags: ['tree', 'birch'], lastModified: 2 });
    ar.markDeltaStale(['/Game/A/SM_Birch']);

    const hits2 = await ar.search('birch', { k: 5 });
    expect(hits2.some(h => h.path === '/Game/A/SM_Birch')).toBe(true);

    const r = await ar.reindex();
    expect(r.docCount).toBe(3);
    expect(r.backend).toBe('bm25');
  });

  it('full rebuild fallback when delta path is missing from registry', async () => {
    const dispatch = vi.fn(async (cmd: string, args?: { paths?: string[] }) => {
      if (cmd === 'describe_assets') {
        if (!args?.paths) return { assets: [{ path: '/Game/A/SM_X', name: 'SM_X', class: 'X', tags: [], lastModified: 1 }] };
        return { assets: [] };
      }
      return {};
    });
    const ar = new AssetRetriever(dispatch, { cacheDir: dir, embeddings: null });
    await ar.search('x');
    ar.markDeltaStale(['/Game/A/SM_Missing']);
    const hits = await ar.search('x');
    expect(hits.length).toBeGreaterThan(0);
  });
});
