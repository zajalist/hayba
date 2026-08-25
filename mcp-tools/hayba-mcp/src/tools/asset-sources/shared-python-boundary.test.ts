import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../tool-executor.js', () => ({
  executeCommand: vi.fn(async () => ({ ok: true })),
}));

import { executeCommand } from '../tool-executor.js';
import {
  AssetEnumerationError,
  ASSET_CONNECTOR_CACHE_ROOT,
  ConnectorCleanupError,
  connectorErrorResult,
  createUniqueCacheDirAtAuthorityForTest,
  enumerateConfinedRegularFiles,
  importIntoUe,
} from './shared.js';

let root: string;

beforeEach(async () => {
  await fsp.mkdir(ASSET_CONNECTOR_CACHE_ROOT, { recursive: true });
  root = await fsp.mkdtemp(path.join(ASSET_CONNECTOR_CACHE_ROOT, 'test-enum-'));
  vi.mocked(executeCommand).mockClear();
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('bounded Node asset enumeration', () => {
  it('returns only confined regular files in deterministic order', async () => {
    await fsp.mkdir(path.join(root, 'nested'));
    await fsp.writeFile(path.join(root, 'z.glb'), 'z');
    await fsp.writeFile(path.join(root, 'nested', 'a.bin'), 'a');

    const files = await enumerateConfinedRegularFiles(root, root);

    expect(files.map((file) => path.relative(root, file).replaceAll('\\', '/'))).toEqual(['nested/a.bin', 'z.glb']);
  });

  it('rejects a junction before the UE continuation can run', async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-asset-outside-'));
    try {
      await fsp.writeFile(path.join(outside, 'outside.fbx'), 'outside');
      await fsp.symlink(outside, path.join(root, 'escape'), 'junction');

      await expect(importIntoUe(root, '/Game/Test', root)).rejects.toMatchObject({
        code: 'HAYBA-ASSET-ENUM-LINK',
      });
      expect(executeCommand).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it.each([
    [{ maxFiles: 1 }, ['a', 'b'], 'HAYBA-ASSET-ENUM-FILES'],
    [{ maxEntries: 1 }, ['a', 'b'], 'HAYBA-ASSET-ENUM-ENTRIES'],
    [{ maxFileBytes: 1 }, ['ab'], 'HAYBA-ASSET-ENUM-FILE-SIZE'],
    [{ maxTotalBytes: 1 }, ['a', 'b'], 'HAYBA-ASSET-ENUM-TOTAL-SIZE'],
  ] as const)('fails closed on %o budget overruns', async (limits, contents, code) => {
    for (const [index, content] of contents.entries()) {
      await fsp.writeFile(path.join(root, `${index}.bin`), content);
    }
    await expect(enumerateConfinedRegularFiles(root, root, limits)).rejects.toMatchObject({ code });
  });

  it('enforces depth before accepting a nested file', async () => {
    await fsp.mkdir(path.join(root, 'one'));
    await fsp.writeFile(path.join(root, 'one', 'two.bin'), 'x');
    await expect(enumerateConfinedRegularFiles(root, root, { maxDepth: 1 })).rejects.toMatchObject({
      code: 'HAYBA-ASSET-ENUM-DEPTH',
    });
  });

  it('rejects a root outside the explicit request authority', async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-asset-unapproved-'));
    try {
      await fsp.writeFile(path.join(outside, 'asset.fbx'), 'x');
      await expect(enumerateConfinedRegularFiles(outside, root)).rejects.toMatchObject({
        code: 'HAYBA-ASSET-ENUM-AUTHORITY',
      });
      expect(executeCommand).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects an import root whose approved ancestor path is a junction', async () => {
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-asset-ancestor-'));
    try {
      await fsp.mkdir(path.join(outside, 'nested'));
      await fsp.writeFile(path.join(outside, 'nested', 'asset.fbx'), 'x');
      const redirect = path.join(root, 'redirect');
      await fsp.symlink(outside, redirect, 'junction');
      await expect(enumerateConfinedRegularFiles(path.join(redirect, 'nested'), root)).rejects.toMatchObject({
        code: 'HAYBA-ASSET-ENUM-LINK',
      });
    } finally {
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects an actual multiply-linked regular file', async () => {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-hardlink-source.fbx`);
    await fsp.writeFile(outside, 'shared inode');
    try {
      await fsp.link(outside, path.join(root, 'linked.fbx'));
      await expect(enumerateConfinedRegularFiles(root, root)).rejects.toMatchObject({
        code: 'HAYBA-ASSET-ENUM-LINK',
      });
      expect(executeCommand).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(outside, { force: true });
    }
  });

  it('detects an actual identity swap before the final recheck', async () => {
    const victim = path.join(root, 'victim.fbx');
    const outside = path.join(path.dirname(root), `${path.basename(root)}-replacement.fbx`);
    await fsp.writeFile(victim, 'trusted');
    await fsp.writeFile(outside, 'replacement');
    try {
      await expect(
        enumerateConfinedRegularFiles(root, root, undefined, {
          beforeIdentityRecheck: async () => {
            await fsp.rm(victim);
            await fsp.link(outside, victim);
          },
        }),
      ).rejects.toMatchObject({ code: 'HAYBA-ASSET-ENUM-RACE' });
      expect(executeCommand).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(outside, { force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('rejects an actual filesystem special node', async () => {
    const socketPath = path.join(root, 'provider.sock');
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(enumerateConfinedRegularFiles(root, root)).rejects.toMatchObject({
        code: 'HAYBA-ASSET-ENUM-TYPE',
      });
      expect(executeCommand).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('pre-download cache authority', () => {
  it('creates and immediately verifies a fresh request-random directory under a real authority', async () => {
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-cache-positive-test-'));
    const authority = path.join(sandbox, 'cache');
    try {
      const request = await createUniqueCacheDirAtAuthorityForTest(authority, 'ambientcg', 'asset');
      expect(path.relative(authority, request)).toMatch(/^ambientcg[\\/]asset-[0-9a-f]{16}-[^\\/]+$/);
      expect((await fsp.lstat(request)).isDirectory()).toBe(true);
    } finally {
      await fsp.rm(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects a connector cache root that is a junction before creating a request leaf', async () => {
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-cache-authority-test-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-cache-authority-outside-'));
    const linkedAuthority = path.join(sandbox, 'cache');
    try {
      await fsp.symlink(outside, linkedAuthority, 'junction');
      await expect(createUniqueCacheDirAtAuthorityForTest(linkedAuthority, 'ambientcg', 'asset')).rejects.toMatchObject(
        { code: 'HAYBA-ASSET-ENUM-LINK' },
      );
      expect(await fsp.readdir(outside)).toEqual([]);
    } finally {
      await fsp.rm(sandbox, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects a connector source parent that is a junction before creating a request leaf', async () => {
    const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-cache-source-test-'));
    const authority = path.join(sandbox, 'cache');
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-cache-source-outside-'));
    try {
      await fsp.mkdir(authority);
      await fsp.symlink(outside, path.join(authority, 'polyhaven'), 'junction');
      await expect(createUniqueCacheDirAtAuthorityForTest(authority, 'polyhaven', 'asset')).rejects.toMatchObject({
        code: 'HAYBA-ASSET-ENUM-LINK',
      });
      expect(await fsp.readdir(outside)).toEqual([]);
    } finally {
      await fsp.rm(sandbox, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('typed import capability gate', () => {
  it('rejects a self-declared approved root outside the connector cache authority', async () => {
    const unapproved = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-unapproved-import-'));
    try {
      await fsp.writeFile(path.join(unapproved, 'mesh.glb'), 'mesh');
      await expect(importIntoUe(unapproved, '/Game/Test', unapproved)).rejects.toMatchObject({
        code: 'HAYBA-ASSET-ENUM-AUTHORITY',
      });
      expect(executeCommand).not.toHaveBeenCalled();
    } finally {
      await fsp.rm(unapproved, { recursive: true, force: true });
    }
  });

  it('enumerates a valid cache but fails closed on #415 without calling UE', async () => {
    await fsp.writeFile(path.join(root, 'mesh.glb'), 'mesh');

    await expect(importIntoUe(root, '/Game/Test', root)).resolves.toEqual({
      ok: false,
      note: expect.stringMatching(/HAYBA-ASSET-IMPORT-TYPED-BLOCKED.*#415/),
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('reports an empty cache without calling UE', async () => {
    await expect(importIntoUe(root, '/Game/Test', root)).resolves.toMatchObject({
      ok: false,
      note: expect.stringContaining('HAYBA-ASSET-IMPORT-EMPTY'),
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it('surfaces primary refusal and retained cleanup facts as structured JSON', () => {
    const primary = new AssetEnumerationError('HAYBA-ASSET-ENUM-LINK', 'refused provider link');
    const failure = new ConnectorCleanupError(primary, [root], Object.assign(new Error('cleanup'), { code: 'EACCES' }));

    const response = connectorErrorResult('ambientcg', failure);
    const payload = JSON.parse(response.content[0]!.text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      ok: false,
      source: 'ambientcg',
      error_code: 'HAYBA-ASSET-ENUM-LINK',
      cleanup_failed: true,
      retained_count: 1,
      cleanup_error: 'EACCES',
    });
    expect(payload.retained_path_refs).toEqual([expect.stringMatching(/^sha256:[0-9a-f]{16}$/)]);
    expect(String(payload.error)).toContain('refused provider link');
    expect(String(payload.error)).not.toContain('cleanup');
    expect(response.content[0]!.text).not.toContain(path.resolve(root));
  });

  it('never exposes private paths, URLs, tokens, or unknown exception text', () => {
    const privatePath = 'C:\\Users\\alice\\secret-project\\asset.zip';
    const privateUrl = 'https://user:token-123@example.test/private.zip?api_key=secret';
    const retained = path.join(root, 'retained-private-cache');
    const retainedPaths = Array.from({ length: 10 }, (_, index) => `${retained}-${index}`);
    const failure = new ConnectorCleanupError(
      Object.assign(new Error(`download ${privateUrl} to ${privatePath} failed`), { code: 'TOKEN_123' }),
      retainedPaths,
      Object.assign(new Error(`could not remove ${retained}; bearer token-123`), { code: 'PRIVATE_TOKEN_456' }),
    );

    const response = connectorErrorResult('sketchfab', failure);
    const payload = JSON.parse(response.content[0]!.text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      error: 'connector operation failed unexpectedly',
      cleanup_failed: true,
      retained_count: 10,
      cleanup_error: 'cleanup operation failed unexpectedly',
    });
    expect(payload.retained_path_refs).toHaveLength(8);
    expect(payload.retained_path_refs).toEqual(
      expect.arrayContaining([expect.stringMatching(/^sha256:[0-9a-f]{16}$/)]),
    );
    for (const secret of [
      privatePath,
      privateUrl,
      'token-123',
      'TOKEN_123',
      'PRIVATE_TOKEN_456',
      retained,
      'alice',
      'secret-project',
    ]) {
      expect(response.content[0]!.text).not.toContain(secret);
    }
  });
});
