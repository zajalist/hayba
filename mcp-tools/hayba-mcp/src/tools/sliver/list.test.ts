import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSliverSystem } from '../../slivers/index.js';
import { sliverListHandler } from './list.js';

describe('hayba_sliver_list', () => {
  let userDir: string;
  let sys: Awaited<ReturnType<typeof setupSliverSystem>>;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-list-'));
    sys = await setupSliverSystem({ userDir, bundledDir: 'src/slivers/specs', maxDepth: 4 });
  });
  afterEach(() => { rmSync(userDir, { recursive: true, force: true }); });

  it('returns all installed slivers', async () => {
    const r = await sliverListHandler({}, { loader: sys.loader });
    expect(r.slivers.length).toBeGreaterThan(0);
    expect(r.slivers[0]).toMatchObject({
      id: 'com.hayba.composition.frame_target',
      category: 'composition',
    });
  });

  it('filters by category', async () => {
    const r = await sliverListHandler({ category: 'composition' }, { loader: sys.loader });
    expect(r.slivers.every(s => s.category === 'composition')).toBe(true);
    const empty = await sliverListHandler({ category: 'does_not_exist' }, { loader: sys.loader });
    expect(empty.slivers).toEqual([]);
  });

  it('filters by namespace prefix', async () => {
    const r = await sliverListHandler({ namespace: 'com.hayba' }, { loader: sys.loader });
    expect(r.slivers.every(s => s.id.startsWith('com.hayba.'))).toBe(true);
  });
});
