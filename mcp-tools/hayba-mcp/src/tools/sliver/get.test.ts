import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSliverSystem } from '../../slivers/index.js';
import { sliverGetHandler } from './get.js';

describe('hayba_sliver_get', () => {
  let userDir: string;
  let sys: Awaited<ReturnType<typeof setupSliverSystem>>;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-get-'));
    sys = await setupSliverSystem({ userDir, bundledDir: 'src/slivers/specs', maxDepth: 4 });
  });
  afterEach(() => { rmSync(userDir, { recursive: true, force: true }); });

  it('returns the full spec for a known id', async () => {
    const r = await sliverGetHandler({ id: 'com.hayba.composition.frame_target' }, { loader: sys.loader });
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.spec.id).toBe('com.hayba.composition.frame_target');
      expect(r.spec.params.length).toBeGreaterThan(0);
    }
  });

  it('returns found=false for unknown id', async () => {
    const r = await sliverGetHandler({ id: 'com.nope.missing' }, { loader: sys.loader });
    expect(r.found).toBe(false);
  });
});
