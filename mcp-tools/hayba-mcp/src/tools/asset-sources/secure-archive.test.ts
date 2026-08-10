import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadExtractThen,
  downloadToFile,
  extractZip,
  fetchJsonBounded,
  safeDownloadLeafName,
  type ArchiveLimits,
} from './secure-archive.js';

interface FixtureEntry {
  name: string;
  content?: Buffer | string;
  method?: 0 | 8;
  flags?: number;
  versionMadeBy?: number;
  externalAttributes?: number;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
  declaredCrc?: number;
  extra?: Buffer;
}

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-archive-test-'));
  roots.push(root);
  return root;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFixture(entries: FixtureEntry[], comment = ''): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const fixture of entries) {
    const name = Buffer.from(fixture.name, 'utf8');
    const source = Buffer.isBuffer(fixture.content) ? fixture.content : Buffer.from(fixture.content ?? '', 'utf8');
    const method = fixture.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(source) : source;
    const flags = fixture.flags ?? 0x800;
    const extra = fixture.extra ?? Buffer.alloc(0);
    const compressedSize = fixture.declaredCompressedSize ?? compressed.length;
    const uncompressedSize = fixture.declaredUncompressedSize ?? source.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(fixture.declaredCrc ?? crc32(source), 14);
    local.writeUInt32LE(compressedSize >>> 0, 18);
    local.writeUInt32LE(uncompressedSize >>> 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    localParts.push(local, name, extra, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(fixture.versionMadeBy ?? (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(fixture.declaredCrc ?? crc32(source), 16);
    central.writeUInt32LE(compressedSize >>> 0, 20);
    central.writeUInt32LE(uncompressedSize >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE((fixture.externalAttributes ?? 0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name, extra);
    localOffset += local.length + name.length + extra.length + compressed.length;
  }

  const locals = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const commentBytes = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(locals.length, 16);
  eocd.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([locals, central, eocd, commentBytes]);
}

async function writeZip(root: string, bytes: Buffer): Promise<string> {
  const file = path.join(root, 'fixture.zip');
  await fsp.writeFile(file, bytes);
  return file;
}

async function rejectArchive(
  entriesOrBytes: FixtureEntry[] | Buffer,
  expectedCode: string,
  limits?: Partial<ArchiveLimits>,
): Promise<void> {
  const root = await tempRoot();
  const zip = await writeZip(root, Buffer.isBuffer(entriesOrBytes) ? entriesOrBytes : zipFixture(entriesOrBytes));
  const destination = path.join(root, 'published');
  await expect(extractZip(zip, destination, limits)).rejects.toMatchObject({
    code: expectedCode,
  });
  await expect(fsp.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fsp.readdir(root)).filter((name) => name.startsWith('.hayba-extract-'))).toEqual([]);
}

describe('secure ZIP metadata preflight', () => {
  it('streams a valid small archive, verifies CRCs, and atomically publishes it', async () => {
    const root = await tempRoot();
    const zip = await writeZip(
      root,
      zipFixture([
        { name: 'model/', externalAttributes: (0o040755 << 16) >>> 0 },
        { name: 'model/mesh.gltf', content: '{"asset":true}', method: 8 },
        { name: 'model/empty.bin' },
      ]),
    );
    const destination = path.join(root, 'published');
    const files = await extractZip(zip, destination);

    expect(files.map((file) => path.relative(destination, file).replaceAll('\\', '/')).sort()).toEqual([
      'model/empty.bin',
      'model/mesh.gltf',
    ]);
    await expect(fsp.readFile(path.join(destination, 'model', 'mesh.gltf'), 'utf8')).resolves.toBe('{"asset":true}');
    await expect(fsp.readFile(path.join(destination, 'model', 'empty.bin'))).resolves.toHaveLength(0);
  });

  it('rejects a declared 4 GB / ZIP64 allocation before inflation', async () => {
    await rejectArchive(
      [{ name: 'bomb.bin', content: 'x', declaredCompressedSize: 0xffffffff, declaredUncompressedSize: 0xffffffff }],
      'HAYBA-ARCHIVE-ENTRY-SIZE',
    );
  });

  it('rejects an extreme compression ratio before inflation', async () => {
    await rejectArchive([{ name: 'ratio.bin', content: Buffer.alloc(20_000, 65), method: 8 }], 'HAYBA-ARCHIVE-RATIO', {
      maxCompressionRatio: 10,
    });
  });

  it('rejects an entry flood before creating the destination', async () => {
    await rejectArchive(
      [
        { name: 'a', content: 'a' },
        { name: 'b', content: 'b' },
        { name: 'c', content: 'c' },
      ],
      'HAYBA-ARCHIVE-ENTRIES',
      { maxEntries: 2 },
    );
  });

  it('enforces filename, depth, per-entry, and total-uncompressed budgets before extraction', async () => {
    await rejectArchive([{ name: 'long-name.bin', content: 'x' }], 'HAYBA-ARCHIVE-NAME', { maxNameBytes: 4 });
    await rejectArchive([{ name: 'a/b/c.bin', content: 'x' }], 'HAYBA-ARCHIVE-DEPTH', { maxDepth: 2 });
    await rejectArchive([{ name: 'large.bin', content: '12345' }], 'HAYBA-ARCHIVE-ENTRY-SIZE', {
      maxEntryUncompressedBytes: 4,
    });
    await rejectArchive(
      [
        { name: 'a.bin', content: '123456' },
        { name: 'b.bin', content: '123456' },
      ],
      'HAYBA-ARCHIVE-TOTAL-SIZE',
      { maxTotalUncompressedBytes: 10 },
    );
  });

  it.each([
    ['../escape.txt', 'zip slip'],
    ['safe/..\\escape.txt', 'backslash traversal'],
    ['/absolute.txt', 'absolute path'],
    ['C:/drive.txt', 'drive path'],
    ['safe/file.txt:secret', 'alternate data stream'],
    ['safe/CON.txt', 'Windows device name'],
    ['safe/trailing. ', 'Win32 normalized collision'],
  ])('rejects %s (%s) without writing outside the stage', async (name) => {
    await rejectArchive([{ name, content: 'owned' }], 'HAYBA-ARCHIVE-PATH');
  });

  it('rejects symlink and reparse metadata', async () => {
    await rejectArchive(
      [{ name: 'link', content: 'target', externalAttributes: (0o120777 << 16) >>> 0 }],
      'HAYBA-ARCHIVE-LINK',
    );
    await rejectArchive([{ name: 'reparse', content: 'target', externalAttributes: 0x400 }], 'HAYBA-ARCHIVE-LINK');
    const asiUnixLinkExtra = Buffer.from([0x6e, 0x75, 0x00, 0x00]);
    await rejectArchive([{ name: 'hardlink', content: 'target', extra: asiUnixLinkExtra }], 'HAYBA-ARCHIVE-LINK');
  });

  it('rejects duplicate-normalized and case-colliding entries', async () => {
    await rejectArchive(
      [
        { name: 'same.txt', content: 'a' },
        { name: 'same.txt', content: 'b' },
      ],
      'HAYBA-ARCHIVE-DUPLICATE',
    );
    await rejectArchive(
      [
        { name: 'Asset/Thing.uasset', content: 'a' },
        { name: 'asset/thing.uasset', content: 'b' },
      ],
      'HAYBA-ARCHIVE-CASE-COLLISION',
    );
    await rejectArchive(
      [
        { name: 'parent', content: 'file' },
        { name: 'parent/child.bin', content: 'child' },
      ],
      'HAYBA-ARCHIVE-COLLISION',
    );
  });

  it('rejects a truncated archive and removes its private extraction stage', async () => {
    const valid = zipFixture([{ name: 'mesh.obj', content: 'v 0 0 0' }]);
    await rejectArchive(valid.subarray(0, valid.length - 7), 'HAYBA-ARCHIVE-TRUNCATED');
  });

  it('removes every staged file when inflation-time CRC verification fails', async () => {
    await rejectArchive(
      [
        { name: 'first.bin', content: 'first' },
        { name: 'bad.bin', content: 'bad', declaredCrc: 0x12345678 },
      ],
      'HAYBA-ARCHIVE-CRC',
    );
  });

  it('enforces one wall-clock deadline across preflight and extraction', async () => {
    const root = await tempRoot();
    const zip = await writeZip(root, zipFixture([{ name: 'mesh.bin', content: Buffer.alloc(4_096, 7), method: 8 }]));
    const destination = path.join(root, 'published');
    vi.useFakeTimers();

    let stageReady!: () => void;
    const reachedStage = new Promise<void>((resolve) => {
      stageReady = resolve;
    });
    let releaseStage!: () => void;
    const stageGate = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const extraction = extractZip(
      zip,
      destination,
      { extractionTimeoutMs: 10 },
      {
        afterStageReady: async () => {
          stageReady();
          await stageGate;
        },
      },
    );
    const rejected = expect(extraction).rejects.toMatchObject({ code: 'HAYBA-ARCHIVE-TIMEOUT' });
    await reachedStage;
    expect((await fsp.readdir(root)).some((name) => name.startsWith('.hayba-extract-'))).toBe(true);
    await vi.advanceTimersByTimeAsync(11);
    releaseStage();
    await rejected;
    vi.useRealTimers();
    await expect(fsp.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fsp.readdir(root)).filter((name) => name.startsWith('.hayba-extract-'))).toEqual([]);
  });

  it('never overwrites an existing extraction destination', async () => {
    const root = await tempRoot();
    const zip = await writeZip(root, zipFixture([{ name: 'new.txt', content: 'new' }]));
    const destination = path.join(root, 'published');
    await fsp.mkdir(destination);
    await fsp.writeFile(path.join(destination, 'keep.txt'), 'keep');

    await expect(extractZip(zip, destination)).rejects.toMatchObject({ code: 'HAYBA-ARCHIVE-COLLISION' });
    await expect(fsp.readFile(path.join(destination, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    await expect(fsp.lstat(path.join(destination, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('bounded archive download', () => {
  it('rejects provider filenames that could escape or alias the request cache', () => {
    expect(() => safeDownloadLeafName('../../outside.fbx')).toThrow(/HAYBA-ARCHIVE-PATH/);
    expect(() => safeDownloadLeafName('folder/asset.fbx')).toThrow(/HAYBA-DOWNLOAD-NAME/);
    expect(() => safeDownloadLeafName('NUL.obj')).toThrow(/HAYBA-ARCHIVE-PATH/);
    expect(safeDownloadLeafName('mesh.glb')).toBe('mesh.glb');
  });

  it('aborts a streaming overrun, removes the temp file, and never publishes a partial download', async () => {
    const root = await tempRoot();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const destination = path.join(root, 'archive.zip');

    await expect(
      downloadToFile('https://assets.invalid/big.zip', destination, undefined, { maxDownloadBytes: 10 }),
    ).rejects.toMatchObject({ code: 'HAYBA-DOWNLOAD-SIZE' });
    await expect(fsp.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fsp.readdir(root)).filter((name) => name.startsWith('.hayba-download-'))).toEqual([]);
  });

  it('aborts a stalled stream at the wall-clock deadline and cleans up', async () => {
    const root = await tempRoot();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const destination = path.join(root, 'archive.zip');

    await expect(
      downloadToFile('https://assets.invalid/stall.zip', destination, undefined, { downloadTimeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'HAYBA-DOWNLOAD-TIMEOUT' });
    await expect(fsp.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses atomic no-clobber publication for downloads', async () => {
    const root = await tempRoot();
    const destination = path.join(root, 'archive.zip');
    await fsp.writeFile(destination, 'trusted');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('untrusted', { status: 200 })),
    );

    await expect(downloadToFile('https://assets.invalid/a.zip', destination)).rejects.toMatchObject({
      code: 'HAYBA-DOWNLOAD-COLLISION',
    });
    await expect(fsp.readFile(destination, 'utf8')).resolves.toBe('trusted');
  });
});

describe('bounded provider metadata', () => {
  it('parses a small UTF-8 JSON response within the same pre-import boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"url":"https://assets.invalid/a.zip"}')),
    );
    await expect(fetchJsonBounded<{ url: string }>('https://provider.invalid/info')).resolves.toEqual({
      url: 'https://assets.invalid/a.zip',
    });
  });

  it('rejects actual metadata bytes beyond the ceiling without echoing body or URL', async () => {
    const sentinel = 'SECRET-SIGNED-URL';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ value: sentinel.repeat(8) }))),
    );
    let error: unknown;
    try {
      await fetchJsonBounded('https://provider.invalid/secret?token=DO_NOT_ECHO', undefined, { maxMetadataBytes: 16 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'HAYBA-METADATA-SIZE' });
    expect(String(error)).not.toContain(sentinel);
    expect(String(error)).not.toContain('DO_NOT_ECHO');
  });
});

describe('download/extract/import boundary', () => {
  it('cannot call the UE import continuation after archive rejection', async () => {
    const root = await tempRoot();
    const cacheRoot = path.join(root, 'request-cache');
    const malicious = zipFixture([{ name: '../../outside.uasset', content: 'owned' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(malicious), { status: 200 })),
    );
    const afterVerified = vi.fn(async () => ({ ok: true }));

    await expect(
      downloadExtractThen({
        url: 'https://assets.invalid/malicious.zip',
        archivePath: path.join(cacheRoot, 'archive.zip'),
        extractDir: path.join(cacheRoot, 'extracted'),
        failureCleanupRoot: cacheRoot,
        afterVerified,
      }),
    ).rejects.toMatchObject({ code: 'HAYBA-ARCHIVE-PATH' });

    expect(afterVerified).not.toHaveBeenCalled();
    await expect(fsp.lstat(cacheRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.lstat(path.join(root, '..', 'outside.uasset'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cannot call the UE import continuation after a download overrun', async () => {
    const root = await tempRoot();
    const cacheRoot = path.join(root, 'request-cache');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const afterVerified = vi.fn(async () => ({ ok: true }));

    await expect(
      downloadExtractThen({
        url: 'https://assets.invalid/oversized.zip',
        archivePath: path.join(cacheRoot, 'archive.zip'),
        extractDir: path.join(cacheRoot, 'extracted'),
        failureCleanupRoot: cacheRoot,
        limits: { maxDownloadBytes: 8 },
        afterVerified,
      }),
    ).rejects.toMatchObject({ code: 'HAYBA-DOWNLOAD-SIZE' });
    expect(afterVerified).not.toHaveBeenCalled();
    await expect(fsp.lstat(cacheRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
