import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sharedMocks = vi.hoisted(() => ({
  cleanupAfterRefusal: vi.fn(async (error: unknown) => error),
  connectorErrorResult: vi.fn((source: string, error: unknown) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: false,
          source,
          error: error instanceof Error ? error.message : String(error),
          cleanup_failed: false,
          retained_count: 0,
          retained_path_refs: [],
        }),
      },
    ],
    isError: true,
  })),
  createUniqueCacheDir: vi.fn(),
  downloadExtractThen: vi.fn(),
  downloadToFile: vi.fn(),
  fetchJsonBounded: vi.fn(),
  importIntoUe: vi.fn(),
  safeDownloadLeafName: vi.fn((name: string) => name),
  verifyAndMarkDelta: vi.fn(),
}));

vi.mock('./shared.js', () => sharedMocks);
vi.mock('./get-setting.js', () => ({
  getTokenWithEnvFallback: vi.fn(async () => 'token'),
}));

import { handleAmbientCgDownload } from './ambientcg-download.js';
import { handlePolyhavenDownload } from './polyhaven-download.js';
import { handleSketchfabDownload } from './sketchfab-download.js';

let cacheRoot: string;

beforeEach(async () => {
  cacheRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'hayba-connector-gate-'));
  vi.clearAllMocks();
  sharedMocks.createUniqueCacheDir.mockResolvedValue(cacheRoot);
  sharedMocks.downloadToFile.mockResolvedValue(undefined);
  sharedMocks.downloadExtractThen.mockImplementation(
    async (options: { afterVerified: (files: string[]) => Promise<unknown> }) => ({
      files: [path.join(cacheRoot, 'extracted', 'asset.glb')],
      result: await options.afterVerified([path.join(cacheRoot, 'extracted', 'asset.glb')]),
    }),
  );
  sharedMocks.verifyAndMarkDelta.mockResolvedValue({ verified: true });
});

afterEach(async () => {
  await fsp.rm(cacheRoot, { recursive: true, force: true });
});

function dataOf(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('connector import capability gate', () => {
  it('AmbientCG reports the typed-boundary blocker and never attempts registry readback', async () => {
    sharedMocks.fetchJsonBounded.mockResolvedValue({
      foundAssets: [
        {
          downloadFolders: {
            default: {
              downloadFiletypeCategories: {
                zip: { downloads: [{ attribute: '2K-JPG', fullDownloadPath: 'https://assets.invalid/a.zip' }] },
              },
            },
          },
        },
      ],
    });
    sharedMocks.importIntoUe.mockResolvedValue({ ok: false, note: 'HAYBA-ASSET-IMPORT-TYPED-BLOCKED: #415' });

    const result = await handleAmbientCgDownload({ asset_id: 'Ground037', resolution: '2K-JPG' });

    expect(result.isError).toBe(true);
    expect(dataOf(result)).toMatchObject({ imported: false, verified: false, verifyReason: 'import_failed' });
    expect(sharedMocks.verifyAndMarkDelta).not.toHaveBeenCalled();
  });

  it('Poly Haven reports the typed-boundary blocker and never attempts registry readback', async () => {
    sharedMocks.fetchJsonBounded.mockResolvedValue({
      Diffuse: { '2k': { jpg: { url: 'https://assets.invalid/diffuse.jpg' } } },
    });
    sharedMocks.importIntoUe.mockResolvedValue({ ok: false, note: 'HAYBA-ASSET-IMPORT-TYPED-BLOCKED: #415' });

    const result = await handlePolyhavenDownload({ asset_id: 'brick', type: 'textures', resolution: '2k' });

    expect(result.isError).toBe(true);
    expect(dataOf(result)).toMatchObject({ imported: false, verified: false, verifyReason: 'import_failed' });
    expect(sharedMocks.verifyAndMarkDelta).not.toHaveBeenCalled();
  });

  it('Sketchfab reports the typed-boundary blocker and never attempts registry readback', async () => {
    sharedMocks.fetchJsonBounded.mockResolvedValue({ gltf: { url: 'https://assets.invalid/model.zip' } });
    sharedMocks.importIntoUe.mockResolvedValue({ ok: false, note: 'HAYBA-ASSET-IMPORT-TYPED-BLOCKED: #415' });

    const result = await handleSketchfabDownload({ uid: 'abc', flavour: 'gltf' });

    expect(result.isError).toBe(true);
    expect(dataOf(result)).toMatchObject({ imported: false, verified: false, verifyReason: 'import_failed' });
    expect(sharedMocks.verifyAndMarkDelta).not.toHaveBeenCalled();
  });

  it.each([
    [
      'AmbientCG',
      () => {
        sharedMocks.fetchJsonBounded.mockResolvedValue({
          foundAssets: [
            {
              downloadFolders: {
                default: {
                  downloadFiletypeCategories: {
                    zip: { downloads: [{ attribute: '2K-JPG', fullDownloadPath: 'https://assets.invalid/a.zip' }] },
                  },
                },
              },
            },
          ],
        });
        return handleAmbientCgDownload({ asset_id: 'Ground037', resolution: '2K-JPG' });
      },
    ],
    [
      'Poly Haven',
      () => {
        sharedMocks.fetchJsonBounded.mockResolvedValue({
          Diffuse: { '2k': { jpg: { url: 'https://assets.invalid/diffuse.jpg' } } },
        });
        return handlePolyhavenDownload({ asset_id: 'brick', type: 'textures', resolution: '2k' });
      },
    ],
    [
      'Sketchfab',
      () => {
        sharedMocks.fetchJsonBounded.mockResolvedValue({ gltf: { url: 'https://assets.invalid/model.zip' } });
        return handleSketchfabDownload({ uid: 'abc', flavour: 'gltf' });
      },
    ],
  ] as const)('%s stops after Node enumeration refusal', async (_name, run) => {
    sharedMocks.importIntoUe.mockRejectedValue(new Error('HAYBA-ASSET-ENUM-LINK'));

    const result = await run();

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('HAYBA-ASSET-ENUM-LINK');
    expect(sharedMocks.verifyAndMarkDelta).not.toHaveBeenCalled();
  });
});
