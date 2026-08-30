import * as path from 'node:path';
import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import {
  createUniqueCacheDir,
  connectorErrorResult,
  downloadExtractThen,
  fetchJsonBounded,
  importIntoUe,
  verifyAndMarkDelta,
  type DownloadedAsset,
} from './shared.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['filesystem_write', 'asset_create'],
  when: 'downloading an ambientCG material zip into the active UE project',
  not_when: 'you only need metadata — use ambientcg_search',
};

export const schema = z.object({
  asset_id: z.string().min(1),
  resolution: z.string().default('2K-JPG').describe('ambientCG attribute string, e.g. 1K-JPG, 2K-JPG, 4K-JPG, 2K-PNG'),
  target_dir: z.string().optional().describe('UE content path. Defaults to /Game/AssetConnectors/ambientcg/<asset_id>'),
});
export type AmbientCgDownloadParams = z.infer<typeof schema>;

const API = 'https://ambientCG.com/api/v2';

export function assetInfoUrl(assetId: string): string {
  const qs = new URLSearchParams();
  qs.set('id', assetId);
  // Without include=downloadData the v2 API returns an EMPTY downloadFolders, so
  // no zip can ever be resolved ("can't resolve its zips"). Request it explicitly.
  qs.set('include', 'downloadData');
  return `${API}/full_json?${qs.toString()}`;
}

/** Find the zip download URL for the requested attribute (e.g. "2K-JPG"). Exported for tests. */
export function pickZipUrl(assetJson: any, resolution: string): string | null {
  const found = Array.isArray(assetJson?.foundAssets) ? assetJson.foundAssets : [];
  const asset = found[0] ?? assetJson;
  // downloadFolders is an OBJECT keyed by folder name (e.g. "default"), not an
  // array — Object.values() so `for..of` actually iterates it. Same for the
  // category map. Path field is fullDownloadPath, with downloadLink as fallback.
  const folders = Object.values(asset?.downloadFolders ?? {});
  const pathOf = (d: any): string | null => (d?.fullDownloadPath ?? d?.downloadLink) || null;
  // Preferred: exact attribute match (case-insensitive).
  for (const folder of folders as any[]) {
    const cats = folder?.downloadFiletypeCategories ?? {};
    const zip = cats?.zip ?? cats?.Zip;
    for (const d of zip?.downloads ?? []) {
      if (typeof d?.attribute === 'string' && d.attribute.toLowerCase() === resolution.toLowerCase() && pathOf(d)) {
        return pathOf(d);
      }
    }
  }
  // Fallback: first available zip in any folder.
  for (const folder of folders as any[]) {
    const cats = folder?.downloadFiletypeCategories ?? {};
    const zip = cats?.zip ?? cats?.Zip;
    const first = (zip?.downloads ?? [])[0];
    if (pathOf(first)) return pathOf(first);
  }
  return null;
}

export async function handleAmbientCgDownload(params: AmbientCgDownloadParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const { asset_id, resolution, target_dir } = parsed.data;
  try {
    const json = await fetchJsonBounded<any>(assetInfoUrl(asset_id));
    const zipUrl = pickZipUrl(json, resolution);
    if (!zipUrl) {
      return {
        content: [{ type: 'text' as const, text: `No zip download found for ${asset_id} @ ${resolution}` }],
        isError: true,
      };
    }
    const cacheDir = await createUniqueCacheDir('ambientcg', asset_id);
    const zipPath = path.join(cacheDir, 'archive.zip');
    const extractDir = path.join(cacheDir, 'extracted');
    const gamePath = target_dir ?? `/Game/AssetConnectors/ambientcg/${asset_id}`;
    const { files, result: importResult } = await downloadExtractThen({
      url: zipUrl,
      archivePath: zipPath,
      extractDir,
      failureCleanupRoot: cacheDir,
      afterVerified: () => importIntoUe(extractDir, gamePath, cacheDir),
    });
    const verify = importResult.ok ? await verifyAndMarkDelta(gamePath) : { verified: false, reason: 'import_failed' };
    const data: DownloadedAsset = {
      assetId: asset_id,
      source: 'ambientcg',
      cachePath: cacheDir,
      files,
      imported: importResult.ok && verify.verified,
      importGamePath: gamePath,
      importNote: importResult.note,
      verified: verify.verified,
      verifyReason: verify.reason,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], isError: !data.imported };
  } catch (e: unknown) {
    return connectorErrorResult('ambientcg', e);
  }
}
