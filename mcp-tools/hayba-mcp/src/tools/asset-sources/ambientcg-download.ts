import * as path from 'node:path';
import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { cachePathFor, downloadToFile, ensureDir, extractZip, importIntoUe, type DownloadedAsset } from './shared.js';

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
  return `${API}/full_json?${qs.toString()}`;
}

/** Find the zip download URL for the requested attribute (e.g. "2K-JPG"). Exported for tests. */
export function pickZipUrl(assetJson: any, resolution: string): string | null {
  const found = Array.isArray(assetJson?.foundAssets) ? assetJson.foundAssets : [];
  const asset = found[0] ?? assetJson;
  const folders = asset?.downloadFolders ?? [];
  for (const folder of folders) {
    const cats = folder?.downloadFiletypeCategories ?? {};
    const zip = cats?.zip ?? cats?.Zip;
    const downloads = zip?.downloads ?? [];
    for (const d of downloads) {
      if (d?.attribute === resolution && d?.fullDownloadPath) return d.fullDownloadPath;
    }
  }
  // Fallback: first available zip
  for (const folder of folders) {
    const cats = folder?.downloadFiletypeCategories ?? {};
    const zip = cats?.zip ?? cats?.Zip;
    const first = zip?.downloads?.[0];
    if (first?.fullDownloadPath) return first.fullDownloadPath;
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
    const res = await fetch(assetInfoUrl(asset_id));
    if (!res.ok) {
      return { content: [{ type: 'text' as const, text: `ambientCG lookup failed: ${res.status} ${res.statusText}` }], isError: true };
    }
    const json = (await res.json()) as any;
    const zipUrl = pickZipUrl(json, resolution);
    if (!zipUrl) {
      return { content: [{ type: 'text' as const, text: `No zip download found for ${asset_id} @ ${resolution}` }], isError: true };
    }
    const cacheDir = cachePathFor('ambientcg', asset_id);
    await ensureDir(cacheDir);
    const zipPath = path.join(cacheDir, `${asset_id}_${resolution}.zip`);
    await downloadToFile(zipUrl, zipPath);
    const extractDir = path.join(cacheDir, 'extracted');
    const files = await extractZip(zipPath, extractDir);
    const gamePath = target_dir ?? `/Game/AssetConnectors/ambientcg/${asset_id}`;
    const importResult = await importIntoUe(extractDir, gamePath);
    const data: DownloadedAsset = {
      assetId: asset_id,
      source: 'ambientcg',
      cachePath: cacheDir,
      files,
      imported: importResult.ok,
      importGamePath: gamePath,
      importNote: importResult.note,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: `ambientCG download error: ${msg}` }], isError: true };
  }
}
