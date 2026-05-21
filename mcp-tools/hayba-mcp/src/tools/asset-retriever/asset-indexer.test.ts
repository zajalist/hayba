import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetIndexer } from './asset-indexer.js';

let tmpDir: string;
let snapPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hayba-tagsnap-'));
  snapPath = join(tmpDir, 'retriever-tags.json');
  process.env.HAYBA_TAG_SNAPSHOT_PATH = snapPath;
});

afterEach(() => {
  delete process.env.HAYBA_TAG_SNAPSHOT_PATH;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

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

  it('writes retriever-tags snapshot after build', async () => {
    const dispatch = vi.fn(async () => ({
      assets: [
        { path: '/Game/Foo/SM_Rock', name: 'SM_Rock', class: 'StaticMesh', tags: ['rock', 'nature'], lastModified: 1 },
        { path: '/Game/Bar/SM_Tree', name: 'SM_Tree', class: 'StaticMesh', tags: ['tree'], lastModified: 2 },
        { path: '/Game/Baz/SM_Empty', name: 'SM_Empty', class: 'StaticMesh', tags: [], lastModified: 3 },
      ],
    }));
    const idx = new AssetIndexer(dispatch);
    await idx.build();
    expect(existsSync(snapPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(snapPath, 'utf8'));
    expect(parsed['/Game/Foo/SM_Rock']).toEqual(['rock', 'nature']);
    expect(parsed['/Game/Bar/SM_Tree']).toEqual(['tree']);
    expect(parsed['/Game/Baz/SM_Empty']).toBeUndefined();
  });
});
