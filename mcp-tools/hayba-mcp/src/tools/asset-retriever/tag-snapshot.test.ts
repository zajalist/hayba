// mcp-tools/hayba-mcp/src/tools/asset-retriever/tag-snapshot.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTagSnapshot } from './tag-snapshot.js';

describe('writeTagSnapshot', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hayba-tag-snap-')); });
  afterEach(()  => { rmSync(dir, { recursive: true, force: true }); });

  it('writes sorted assetPath → tags map as JSON', () => {
    const out = join(dir, 'retriever-tags.json');
    writeTagSnapshot(out, [
      { path: '/Game/Foliage/SM_Pine',    tags: ['foliage', 'tree', 'conifer'] },
      { path: '/Game/Maritime/SM_Anchor', tags: ['maritime', 'metal'] },
    ]);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['/Game/Foliage/SM_Pine', '/Game/Maritime/SM_Anchor']);
    expect(parsed['/Game/Maritime/SM_Anchor']).toEqual(['maritime', 'metal']);
  });

  it('drops hits with no tags', () => {
    const out = join(dir, 'snap.json');
    writeTagSnapshot(out, [
      { path: '/Game/A', tags: [] },
      { path: '/Game/B', tags: ['x'] },
    ]);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(parsed)).toEqual(['/Game/B']);
  });

  it('is idempotent on identical input', () => {
    const out = join(dir, 'snap.json');
    const hits = [{ path: '/Game/X', tags: ['a', 'b'] }];
    writeTagSnapshot(out, hits);
    const first = readFileSync(out, 'utf8');
    writeTagSnapshot(out, hits);
    expect(readFileSync(out, 'utf8')).toBe(first);
  });
});
