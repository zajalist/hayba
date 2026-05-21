import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRetriever } from '../asset-retriever.js';
import { assetSearchHandler, assetSearchSchema } from './search.js';
import { assetBrowseHandler } from './browse.js';
import { assetReindexHandler } from './reindex.js';

function ar() {
  const dispatch = vi.fn(async () => ({
    assets: [
      { path: '/Game/A/SM_Pine', name: 'SM_Pine', class: 'StaticMesh', tags: ['tree'], lastModified: 1 },
    ],
  }));
  const dir = mkdtempSync(join(tmpdir(), 'hayba-mt-'));
  const r = new AssetRetriever(dispatch, { cacheDir: dir, embeddings: null });
  return { r, dir };
}

describe('asset meta-tools', () => {
  it('search returns hits', async () => {
    const { r, dir } = ar();
    try {
      const res = await assetSearchHandler({ query: 'pine' }, { retriever: r });
      expect(res.hits[0].path).toBe('/Game/A/SM_Pine');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('search schema accepts optional filters', () => {
    const parsed = z.object(assetSearchSchema).parse({ query: 'x', filterClass: 'StaticMesh', filterSource: 'project' });
    expect(parsed.filterClass).toBe('StaticMesh');
  });

  it('browse returns paginated page', async () => {
    const { r, dir } = ar();
    try {
      const res = await assetBrowseHandler({}, { retriever: r });
      expect(res.total).toBe(1);
      expect(res.docs).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reindex returns summary', async () => {
    const { r, dir } = ar();
    try {
      const res = await assetReindexHandler({}, { retriever: r });
      expect(res.ok).toBe(true);
      expect(res.docCount).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
