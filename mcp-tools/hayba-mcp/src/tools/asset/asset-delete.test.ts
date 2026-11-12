/**
 * asset_delete reported 34 deleted while 34 .uasset files were still on disk.
 *
 * Reproduced live 2026-07-30: the asset registry and the filesystem can
 * disagree, and when they do the registry is the one that lies —
 * `does_asset_exist` returned false for an asset whose file was still present,
 * and a retry of the delete then returned false because the registry could no
 * longer find it. Anything that verifies a delete by asking the registry is
 * asking the component that was already wrong.
 *
 * These tests pin the contract that came out of that: `deleted` means the FILE
 * is gone, and a batch that removed nothing is a failure rather than a partial
 * success.
 *
 * Also: ThirdPersonCharacter hang class (2026-09) — cost was `low` (2s) while
 * DeleteAsset load+force-delete of marketplace Character BPs routinely exceeds
 * that, so the MCP client timed out. asset_delete is now a heavy op (300s).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { assetDeleteHandler, normalizeAssetPath, meta as assetDeleteMeta } from './asset-delete.js';
import {
  UeToolError,
  executeCommand,
  resolveTimeoutMs,
  costToTimeoutMs,
  type Sender,
} from '../tool-executor.js';
import { isHeavyOp, HEAVY_OP_TIMEOUT_MS } from '../heavy-ops.js';
import { registerToolMeta, resetToolMetaRegistry } from '../tool-meta-registry.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}

describe('normalizeAssetPath', () => {
  it('strips newlines and indentation agents inject via line-wrapping', () => {
    expect(
      normalizeAssetPath(
        '/Game/PN_WildBerries/\n        UE4_ThirdPerson/Blueprints/ThirdPersonCharacter.ThirdPersonCharacter',
      ),
    ).toBe('/Game/PN_WildBerries/UE4_ThirdPerson/Blueprints/ThirdPersonCharacter.ThirdPersonCharacter');
  });
});

describe('asset_delete', () => {
  it('forwards a batch as one call rather than a path at a time', async () => {
    // Looping one call per asset is what let a partial failure read as a clean
    // sweep — each individual call "succeeded".
    ue = scriptedUe().replies('asset_delete', { requested: 3, deleted_count: 3, still_on_disk_count: 0, results: [] });
    await assetDeleteHandler({ paths: ['/Game/A', '/Game/B', '/Game/C'] }, {} as never);
    expect(ue.calls).toHaveLength(1);
    expect(ue.paramsFor('asset_delete').paths).toEqual(['/Game/A', '/Game/B', '/Game/C']);
  });

  it('normalizes whitespace-wrapped paths before they hit the wire', async () => {
    ue = scriptedUe().replies('asset_delete', { requested: 1, deleted_count: 1, still_on_disk_count: 0, results: [] });
    await assetDeleteHandler(
      {
        paths: [
          '/Game/PN_GrassLibrary/UE4ThirdPersonTemplate/ThirdPersonBP/Blueprints/ThirdPersonCharacter.ThirdPersonCharacter',
          '/Game/PN_WildBerries/\n        UE4_ThirdPerson/Blueprints/ThirdPersonCharacter.ThirdPersonCharacter',
        ],
      },
      {} as never,
    );
    expect(ue.paramsFor('asset_delete').paths).toEqual([
      '/Game/PN_GrassLibrary/UE4ThirdPersonTemplate/ThirdPersonBP/Blueprints/ThirdPersonCharacter.ThirdPersonCharacter',
      '/Game/PN_WildBerries/UE4_ThirdPerson/Blueprints/ThirdPersonCharacter.ThirdPersonCharacter',
    ]);
  });

  it('surfaces the still-on-disk warning instead of just a count', async () => {
    ue = scriptedUe().replies('asset_delete', {
      requested: 34,
      deleted_count: 0,
      still_on_disk_count: 34,
      warning: '34 of 34 assets are STILL ON DISK.',
      results: [],
    });
    const r = await assetDeleteHandler({ paths: ['/Game/A'] }, {} as never);
    const body = JSON.parse(textOf(r)) as { deleted_count: number; still_on_disk_count: number; warning: string };
    expect(body.deleted_count).toBe(0);
    expect(body.still_on_disk_count).toBe(34);
    expect(body.warning).toContain('STILL ON DISK');
  });

  it('reports per-path outcomes so a partial batch is not read as success', async () => {
    ue = scriptedUe().replies('asset_delete', {
      requested: 2,
      deleted_count: 1,
      still_on_disk_count: 1,
      results: [
        { path: '/Game/Gone', deleted: true, file_gone: true },
        { path: '/Game/Stuck', deleted: false, file_gone: false, reason: 'ORPHANED: ...' },
      ],
    });
    const r = await assetDeleteHandler({ paths: ['/Game/Gone', '/Game/Stuck'] }, {} as never);
    const body = JSON.parse(textOf(r)) as { results: Array<{ path: string; deleted: boolean; reason?: string }> };
    expect(body.results.find((x) => x.path === '/Game/Stuck')?.deleted).toBe(false);
    expect(body.results.find((x) => x.path === '/Game/Stuck')?.reason).toContain('ORPHANED');
  });

  it('treats a batch that deleted nothing as an error, not a quiet zero', async () => {
    // The whole bug in one assertion: a response that says "ok" while every
    // file remains is the shape that cost a wrong conclusion.
    ue = scriptedUe().fails('asset_delete', 'asset_delete: nothing was deleted (34 requested, 34 still on disk)');
    await expect(assetDeleteHandler({ paths: ['/Game/A'] }, {} as never)).rejects.toBeInstanceOf(UeToolError);
  });

  it('rejects a call with neither path nor paths, without contacting UE', async () => {
    ue = scriptedUe();
    const r = await assetDeleteHandler({}, {} as never);
    expect(r.isError).toBe(true);
    expect(ue.calls).toEqual([]);
  });

  it('still accepts a single path', async () => {
    ue = scriptedUe().replies('asset_delete', { requested: 1, deleted_count: 1, still_on_disk_count: 0, results: [] });
    await assetDeleteHandler({ path: '/Game/Foo/MF_X.MF_X' }, {} as never);
    expect(ue.paramsFor('asset_delete').path).toBe('/Game/Foo/MF_X.MF_X');
  });
});

describe('asset_delete timeout tier (ThirdPersonCharacter hang class)', () => {
  afterEach(() => {
    resetToolMetaRegistry();
  });

  it('is registered as a heavy op so the client waits through package load+force-delete', () => {
    expect(isHeavyOp('asset_delete')).toBe(true);
    expect(assetDeleteMeta.cost).toBe('high');
  });

  it('resolves to the 300s heavy timeout, not the old 2s low cost tier', () => {
    registerToolMeta('asset_delete', assetDeleteMeta);
    expect(resolveTimeoutMs('asset_delete')).toBe(HEAVY_OP_TIMEOUT_MS);
    expect(resolveTimeoutMs('asset_delete')).not.toBe(costToTimeoutMs('low'));
  });

  it('executeCommand sends the heavy timeout on the wire', async () => {
    const seen: number[] = [];
    const spy: Sender = async (_c, _p, t) => {
      seen.push(t);
      return { id: 't', ok: true, data: { deleted_count: 0 } };
    };
    await executeCommand('asset_delete', { path: '/Game/A.A' }, { sender: spy });
    expect(seen[0]).toBe(HEAVY_OP_TIMEOUT_MS);
  });
});
