import { describe, it, expect, vi } from 'vitest';
import { AssetIndexer } from './asset-indexer.js';

describe('AssetIndexer', () => {
  it('uses describe_assets when available', async () => {
    const dispatch = vi.fn(async (cmd: string) => ({
      assets: [
        { path: '/Game/Foo/SM_Rock', name: 'SM_Rock', class: 'StaticMesh', tags: ['rock'], lastModified: 1 },
      ],
    }));
    const idx = new AssetIndexer(dispatch);
    const r = await idx.build();
    expect(r.fallbackUsed).toBe(false);
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].source).toBe('project');
    expect(r.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('falls back to list_pcg_assets on unknown_command', async () => {
    const dispatch = vi.fn(async (cmd: string) => {
      if (cmd === 'describe_assets') throw new Error('unknown_command');
      return { assets: [{ path: '/Game/Bar/SM_Foo' }] };
    });
    const idx = new AssetIndexer(dispatch);
    const r = await idx.build();
    expect(r.fallbackUsed).toBe(true);
    expect(r.docs[0].name).toBe('SM_Foo');
    expect(r.docs[0].class).toBe('Unknown');
    expect(r.docs[0].tags).toEqual([]);
  });

  it('describeDelta calls describe_assets with paths', async () => {
    const dispatch = vi.fn(async (cmd: string, args: any) => ({
      assets: args.paths.map((p: string) => ({ path: p, name: p.split('/').pop(), class: 'X', tags: [], lastModified: 1 })),
    }));
    const idx = new AssetIndexer(dispatch);
    const docs = await idx.describeDelta(['/Game/A', '/Game/B']);
    expect(docs).toHaveLength(2);
  });

  it('stable snapshotHash across builds with identical data', async () => {
    const dispatch = vi.fn(async () => ({
      assets: [{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 10 }],
    }));
    const idx = new AssetIndexer(dispatch);
    const r1 = await idx.build();
    const r2 = await idx.build();
    expect(r1.snapshotHash).toBe(r2.snapshotHash);
  });
});
