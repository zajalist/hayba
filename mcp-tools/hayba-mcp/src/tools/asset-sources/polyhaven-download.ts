import * as path from 'node:path';
import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { cachePathFor, downloadToFile, ensureDir, importIntoUe, verifyAndMarkDelta, type DownloadedAsset } from './shared.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['filesystem_write', 'asset_create'],
  when: 'downloading a Poly Haven HDRI / texture / model into the active UE project',
  not_when: 'you only need metadata — use polyhaven_search',
};

export const schema = z.object({
  asset_id: z.string().min(1),
  type: z.enum(['hdris', 'textures', 'models']).default('textures'),
  resolution: z.enum(['1k', '2k', '4k', '8k']).default('2k'),
  target_dir: z.string().optional().describe('UE content path. Defaults to /Game/AssetConnectors/polyhaven/<asset_id>'),
});
export type PolyhavenDownloadParams = z.infer<typeof schema>;

const API = 'https://api.polyhaven.com';

export function filesUrl(assetId: string): string {
  return `${API}/files/${encodeURIComponent(assetId)}`;
}

/** Picks (url, filename) tuples for the requested resolution + type. Exported for tests. */
export function pickDownloads(
  files: Record<string, any>,
  type: 'hdris' | 'textures' | 'models',
  resolution: string,
): Array<{ mapName: string; url: string; filename: string }> {
  const picks: Array<{ mapName: string; url: string; filename: string }> = [];

  if (type === 'hdris') {
    const hdri = files?.hdri?.[resolution];
    if (hdri) {
      const fmt = hdri.hdr ?? hdri.exr;
      if (fmt?.url) picks.push({ mapName: 'hdri', url: fmt.url, filename: path.basename(fmt.url) });
    }
    return picks;
  }

  if (type === 'models') {
    const gltf = files?.gltf?.[resolution]?.gltf;
    if (gltf?.url) picks.push({ mapName: 'gltf', url: gltf.url, filename: path.basename(gltf.url) });
    // Include the bin + textures referenced by the gltf if exposed in includes
    const includes = gltf?.include ?? {};
    for (const [name, info] of Object.entries(includes as Record<string, any>)) {
      if (info?.url) picks.push({ mapName: name, url: info.url, filename: name });
    }
    return picks;
  }

  // textures: each top-level key is a map (Diffuse, Normal, Roughness, AO, …)
  for (const [mapName, byRes] of Object.entries(files ?? {})) {
    const block = (byRes as any)?.[resolution];
    if (!block) continue;
    const fmt = block.jpg ?? block.png ?? block.exr;
    if (fmt?.url) picks.push({ mapName, url: fmt.url, filename: path.basename(fmt.url) });
  }
  return picks;
}

export async function handlePolyhavenDownload(params: PolyhavenDownloadParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const { asset_id, type, resolution, target_dir } = parsed.data;
  try {
    const res = await fetch(filesUrl(asset_id));
    if (!res.ok) {
      return { content: [{ type: 'text' as const, text: `Poly Haven files lookup failed: ${res.status} ${res.statusText}` }], isError: true };
    }
    const files = (await res.json()) as Record<string, any>;
    const picks = pickDownloads(files, type, resolution);
    if (picks.length === 0) {
      return { content: [{ type: 'text' as const, text: `No downloadable files for ${asset_id} at ${resolution}` }], isError: true };
    }
    const cacheDir = cachePathFor('polyhaven', asset_id);
    await ensureDir(cacheDir);
    const written: string[] = [];
    for (const pick of picks) {
      const dest = path.join(cacheDir, pick.filename);
      await downloadToFile(pick.url, dest);
      written.push(dest);
    }
    const gamePath = target_dir ?? `/Game/AssetConnectors/polyhaven/${asset_id}`;
    const importResult = await importIntoUe(cacheDir, gamePath);
    const verify = importResult.ok ? await verifyAndMarkDelta(gamePath) : { verified: false, reason: 'import_failed' };
    const data: DownloadedAsset = {
      assetId: asset_id,
      source: 'polyhaven',
      cachePath: cacheDir,
      files: written,
      imported: importResult.ok && verify.verified,
      importGamePath: gamePath,
      importNote: importResult.note,
      verified: verify.verified,
      verifyReason: verify.reason,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: `Poly Haven download error: ${msg}` }], isError: true };
  }
}
