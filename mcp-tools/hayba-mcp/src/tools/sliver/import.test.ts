// mcp-tools/hayba-mcp/src/tools/sliver/import.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSliverSystem } from '../../slivers/index.js';
import { sliverImportHandler } from './import.js';

const sample = {
  id: 'com.example.cool.thing',
  version: '1.0.0',
  category: 'demo',
  title: 'Cool Thing',
  description: 'demo',
  author: 'example',
  params: [],
  executor: { kind: 'demo.cool' },
  determinism: { pure: true, declared_outputs: [], side_effects: [], seed_param: null },
};

describe('hayba_sliver_import', () => {
  let userDir: string;
  let srcDir: string;
  let sys: Awaited<ReturnType<typeof setupSliverSystem>>;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-imp-u-'));
    srcDir  = mkdtempSync(join(tmpdir(), 'hayba-sl-imp-s-'));
    sys = await setupSliverSystem({ userDir, bundledDir: 'src/slivers/specs', maxDepth: 4 });
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('imports a local file path and installs it to userDir', async () => {
    const p = join(srcDir, 'cool.sliver.json');
    writeFileSync(p, JSON.stringify(sample));
    const r = await sliverImportHandler({ source: p }, { loader: sys.loader });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.id).toBe('com.example.cool.thing');
      expect(existsSync(join(userDir, 'com.example.cool.thing.sliver.json'))).toBe(true);
    }
    expect(sys.loader.get('com.example.cool.thing')).toBeDefined();
  });

  it('imports an https URL via fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(sample), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const r = await sliverImportHandler({ source: 'https://example.com/cool.sliver.json' }, { loader: sys.loader });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
  });

  it('rejects sources that are not file paths or https URLs', async () => {
    const r = await sliverImportHandler({ source: 'ftp://example.com/x' }, { loader: sys.loader });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/source/i);
  });

  it('rejects malformed JSON content', async () => {
    const p = join(srcDir, 'bad.sliver.json');
    writeFileSync(p, '{ not json');
    const r = await sliverImportHandler({ source: p }, { loader: sys.loader });
    expect(r.ok).toBe(false);
  });

  it('rejects specs that fail schema validation', async () => {
    const p = join(srcDir, 'bad.sliver.json');
    writeFileSync(p, JSON.stringify({ ...sample, id: 'not-reverse-dns' }));
    const r = await sliverImportHandler({ source: p }, { loader: sys.loader });
    expect(r.ok).toBe(false);
  });
});
