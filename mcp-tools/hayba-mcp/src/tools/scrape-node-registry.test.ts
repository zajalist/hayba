import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { scrapeNodeRegistry } from './scrape-node-registry.js';

const previousSource = process.env.HAYBA_PCGEX_SOURCE;
afterEach(() => {
  if (previousSource === undefined) delete process.env.HAYBA_PCGEX_SOURCE;
  else process.env.HAYBA_PCGEX_SOURCE = previousSource;
  vi.restoreAllMocks();
});

describe('scrape node registry source selection', () => {
  it('reports a missing source before creating a DB or catalog', async () => {
    delete process.env.HAYBA_PCGEX_SOURCE;
    const dbPath = join(tmpdir(), `hayba-missing-source-${randomUUID()}.db`);
    const result = await scrapeNodeRegistry({ outputDbPath: dbPath, forceRescan: false });
    expect(result.nodesFound).toBe(0);
    expect(result.errors).toEqual([expect.stringContaining('pluginSourcePath or HAYBA_PCGEX_SOURCE')]);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('rejects a configured source that is not a directory before touching output', async () => {
    const source = join(tmpdir(), `hayba-absent-pcgex-${randomUUID()}`);
    const dbPath = join(tmpdir(), `hayba-absent-source-${randomUUID()}.db`);
    const result = await scrapeNodeRegistry({ pluginSourcePath: source, outputDbPath: dbPath, forceRescan: false });
    expect(result.errors).toEqual([expect.stringContaining('does not exist or is not a directory')]);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('preserves an existing DB and catalog when source is missing, absent, or unrelated', async () => {
    delete process.env.HAYBA_PCGEX_SOURCE;
    for (const kind of ['missing', 'absent', 'unrelated'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'hayba-source-guard-'));
      try {
        const dbPath = join(root, 'registry.db');
        const catalogPath = join(root, 'node_catalog.json');
        const dbBytes = Buffer.from([0x48, 0x41, 0x59, 0x42, 0x41, 0, 0xff]);
        const catalogBytes = Buffer.from('{"sentinel":"keep"}\n');
        writeFileSync(dbPath, dbBytes);
        writeFileSync(catalogPath, catalogBytes);
        const source = join(root, 'source');
        if (kind === 'unrelated') mkdirSync(source);
        const result = await scrapeNodeRegistry({
          ...(kind === 'missing' ? {} : { pluginSourcePath: source }),
          outputDbPath: dbPath,
          forceRescan: true,
        });
        expect(result.nodesFound, kind).toBe(0);
        expect(result.errors.length, kind).toBeGreaterThan(0);
        expect(readFileSync(dbPath), kind).toEqual(dbBytes);
        expect(readFileSync(catalogPath), kind).toEqual(catalogBytes);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('rejects comment-only and quoted PCGEx declarations before forceRescan', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hayba-fake-source-'));
    try {
      const source = join(root, 'Source');
      const publicDir = join(source, 'UnrelatedModule', 'Public');
      mkdirSync(publicDir, { recursive: true });
      writeFileSync(join(publicDir, 'Fake.h'), [
        '// class UPCGExLineSettings : public UPCGSettings {};',
        '/* class UPCGExBlockSettings : public UPCGSettings {}; */',
        'const char* example = "class UPCGExStringSettings : public UPCGSettings {};";',
        'const char* raw = R"(class UPCGExRawSettings : public UPCGSettings {};)";',
      ].join('\n'));
      const dbPath = join(root, 'registry.db');
      const catalogPath = join(root, 'node_catalog.json');
      const dbBytes = Buffer.from([0x48, 0x41, 0x59, 0x42, 0x41, 0, 0xff]);
      const catalogBytes = Buffer.from('{"sentinel":"keep"}\n');
      writeFileSync(dbPath, dbBytes);
      writeFileSync(catalogPath, catalogBytes);

      const result = await scrapeNodeRegistry({ pluginSourcePath: source, outputDbPath: dbPath, forceRescan: true });
      expect(result.nodesFound).toBe(0);
      expect(result.errors).toEqual([expect.stringContaining('No recognizable PCGEx node headers')]);
      expect(readFileSync(dbPath)).toEqual(dbBytes);
      expect(readFileSync(catalogPath)).toEqual(catalogBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a recognizable public PCGEx node and writes its catalog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hayba-valid-source-'));
    try {
      const source = join(root, 'Source');
      const publicDir = join(source, 'PCGExtendedToolkit', 'Public');
      mkdirSync(publicDir, { recursive: true });
      writeFileSync(join(publicDir, 'PCGExSample.h'),
        'class UPCGExSampleSettings : public UPCGSettings {};\n');
      const dbPath = join(root, 'registry.db');
      const result = await scrapeNodeRegistry({
        pluginSourcePath: source, outputDbPath: dbPath, forceRescan: true,
      });
      expect(result.errors).toEqual([]);
      expect(result.nodesFound).toBe(1);
      expect(existsSync(dbPath)).toBe(true);
      const db = new DatabaseSync(dbPath);
      expect(db.prepare('SELECT header_path FROM nodes').all()).toEqual([
        { header_path: 'PCGExtendedToolkit/Public/PCGExSample.h' },
      ]);
      db.prepare('INSERT INTO nodes(class, module, display_name, description, header_path) VALUES (?,?,?,?,?)')
        .run('UPCGExStaleSettings', 'PCGExtendedToolkit', 'Stale', '', 'D:/old/source/Private.h');
      db.close();

      const rescanned = await scrapeNodeRegistry({ pluginSourcePath: source, outputDbPath: dbPath, forceRescan: false });
      expect(rescanned.errors).toEqual([]);
      const freshDb = new DatabaseSync(dbPath);
      expect(freshDb.prepare('SELECT header_path FROM nodes').all()).toEqual([
        { header_path: 'PCGExtendedToolkit/Public/PCGExSample.h' },
      ]);
      freshDb.close();
      const catalog = JSON.parse(readFileSync(join(root, 'node_catalog.json'), 'utf8'));
      expect(catalog._meta.node_count).toBe(1);
      expect(catalog.categories.PCGExtendedToolkit.nodes[0].class).toBe('UPCGExSampleSettings');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
