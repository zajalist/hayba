import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SliverLoader } from './loader.js';

const validSpec = {
  id: 'com.test.demo',
  version: '1.0.0',
  category: 'test',
  title: 'Demo',
  description: '',
  author: 'test',
  params: [],
  executor: { kind: 'test.demo' },
  determinism: { pure: true, declared_outputs: [], side_effects: [], seed_param: null },
};

describe('SliverLoader', () => {
  let userDir: string;
  let bundledDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sliver-user-'));
    bundledDir = mkdtempSync(join(tmpdir(), 'hayba-sliver-bundled-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(bundledDir, { recursive: true, force: true });
  });

  it('loads valid specs from userDir', async () => {
    writeFileSync(join(userDir, 'com.test.demo.sliver.json'), JSON.stringify(validSpec));
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.list().map(s => s.id)).toEqual(['com.test.demo']);
    expect(loader.get('com.test.demo')?.title).toBe('Demo');
  });

  it('seeds userDir from bundledDir on first reload if userDir lacks the spec', async () => {
    writeFileSync(join(bundledDir, 'com.test.demo.sliver.json'), JSON.stringify(validSpec));
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    expect(existsSync(join(userDir, 'com.test.demo.sliver.json'))).toBe(true);
    expect(loader.get('com.test.demo')).toBeDefined();
  });

  it('userDir wins over bundledDir when both have the same id', async () => {
    writeFileSync(join(bundledDir, 'com.test.demo.sliver.json'), JSON.stringify(validSpec));
    writeFileSync(join(userDir, 'com.test.demo.sliver.json'), JSON.stringify({ ...validSpec, title: 'User Override' }));
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.get('com.test.demo')?.title).toBe('User Override');
  });

  it('skips and logs invalid specs without failing the whole reload', async () => {
    writeFileSync(join(userDir, 'good.sliver.json'), JSON.stringify(validSpec));
    writeFileSync(join(userDir, 'bad.sliver.json'), '{ not valid json');
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.list().length).toBe(1);
    expect(loader.errors().length).toBe(1);
    expect(loader.errors()[0]).toMatch(/bad\.sliver\.json/);
  });

  it('install writes a spec to userDir and adds it to the in-memory map', async () => {
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    const r = loader.install(validSpec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe('com.test.demo');
    expect(existsSync(join(userDir, 'com.test.demo.sliver.json'))).toBe(true);
    expect(loader.get('com.test.demo')).toBeDefined();
  });

  it('install rejects malformed specs', async () => {
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    const r = loader.install({ ...validSpec, id: 'not-reverse-dns' });
    expect(r.ok).toBe(false);
  });

  it('ignores non-sliver json files', async () => {
    writeFileSync(join(userDir, 'com.test.demo.preset.json'), JSON.stringify({ distance: 5 }));
    writeFileSync(join(userDir, 'README.md'), '# slivers');
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.list()).toEqual([]);
  });
});
