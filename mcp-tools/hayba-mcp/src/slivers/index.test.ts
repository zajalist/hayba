import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSliverSystem } from './index.js';

describe('setupSliverSystem', () => {
  let userDir: string;
  let bundledDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sliver-sys-u-'));
    bundledDir = mkdtempSync(join(tmpdir(), 'hayba-sliver-sys-b-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(bundledDir, { recursive: true, force: true });
  });

  it('wires loader + registry + runtime and registers built-in executors', async () => {
    const sys = await setupSliverSystem({ userDir, bundledDir, maxDepth: 4 });
    expect(sys.registry.kinds()).toContain('composition.frame_target');
    expect(sys.runtime).toBeDefined();
    expect(sys.loader).toBeDefined();
  });

  it('seeds the bundled frame_target spec into userDir when bundledDir contains it', async () => {
    const { copyFileSync, mkdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    mkdirSync(bundledDir, { recursive: true });
    copyFileSync(
      resolve('src/slivers/specs/com.hayba.composition.frame_target.sliver.json'),
      join(bundledDir, 'com.hayba.composition.frame_target.sliver.json'),
    );
    const sys = await setupSliverSystem({ userDir, bundledDir, maxDepth: 4 });
    expect(sys.loader.get('com.hayba.composition.frame_target')).toBeDefined();

    const r = await sys.runtime.runSliver('com.hayba.composition.frame_target', { target: '/Game/X.X' });
    expect(r.ok).toBe(true);
    expect(r.outputs).toHaveProperty('camera_transform');
  });
});
