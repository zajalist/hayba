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
 */

import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { assetDeleteHandler } from './asset-delete.js';
import { UeToolError } from '../tool-executor.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}

describe('asset_delete', () => {
  it('forwards a batch as one call rather than a path at a time', async () => {
    // Looping one call per asset is what let a partial failure read as a clean
    // sweep — each individual call "succeeded".
    ue = scriptedUe().replies('asset_delete', { requested: 3, deleted_count: 3, still_on_disk_count: 0, results: [] });
    await assetDeleteHandler({ paths: ['/Game/A', '/Game/B', '/Game/C'] }, {} as never);
    expect(ue.calls).toHaveLength(1);
    expect(ue.paramsFor('asset_delete').paths).toEqual(['/Game/A', '/Game/B', '/Game/C']);
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
