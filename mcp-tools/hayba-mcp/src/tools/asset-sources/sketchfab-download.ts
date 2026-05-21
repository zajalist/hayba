import * as path from 'node:path';
import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { cachePathFor, downloadToFile, ensureDir, extractZip, importIntoUe, verifyAndMarkDelta, type DownloadedAsset } from './shared.js';
import { tokenMissingMessage } from './sketchfab-search.js';
import { getTokenWithEnvFallback } from './get-setting.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['filesystem_write', 'asset_create'],
  when: 'downloading a Sketchfab model into the active UE project (token from Project Settings → Plugins → Hayba MCP Toolkit → Asset Connectors, or SKETCHFAB_API_TOKEN env var)',
  not_when: 'you only need metadata — use sketchfab_search',
};

export const schema = z.object({
  uid: z.string().min(1).describe('Sketchfab model uid'),
  flavour: z.enum(['gltf', 'usdz', 'source']).default('gltf'),
  target_dir: z.string().optional().describe('UE content path. Defaults to /Game/AssetConnectors/sketchfab/<uid>'),
});
export type SketchfabDownloadParams = z.infer<typeof schema>;

const API = 'https://api.sketchfab.com/v3';

export function downloadInfoUrl(uid: string): string {
  return `${API}/models/${encodeURIComponent(uid)}/download`;
}

/** Picks the signed download url for the requested flavour. Exported for tests. */
export function pickFlavourUrl(downloadJson: any, flavour: 'gltf' | 'usdz' | 'source'): string | null {
  return downloadJson?.[flavour]?.url ?? null;
}

export async function handleSketchfabDownload(params: SketchfabDownloadParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const token = await getTokenWithEnvFallback('sketchfab_api_token', 'SKETCHFAB_API_TOKEN');
  if (!token) {
    return { content: [{ type: 'text' as const, text: tokenMissingMessage() }], isError: true };
  }
  const { uid, flavour, target_dir } = parsed.data;
  try {
    const res = await fetch(downloadInfoUrl(uid), { headers: { Authorization: `Token ${token}` } });
    if (!res.ok) {
      return { content: [{ type: 'text' as const, text: `Sketchfab download lookup failed: ${res.status} ${res.statusText}` }], isError: true };
    }
    const info = (await res.json()) as any;
    const signedUrl = pickFlavourUrl(info, flavour);
    if (!signedUrl) {
      return { content: [{ type: 'text' as const, text: `No ${flavour} download available for ${uid}` }], isError: true };
    }
    const cacheDir = cachePathFor('sketchfab', uid);
    await ensureDir(cacheDir);
    const zipPath = path.join(cacheDir, `${uid}_${flavour}.zip`);
    await downloadToFile(signedUrl, zipPath);
    const extractDir = path.join(cacheDir, 'extracted');
    const files = await extractZip(zipPath, extractDir);
    const gamePath = target_dir ?? `/Game/AssetConnectors/sketchfab/${uid}`;
    const importResult = await importIntoUe(extractDir, gamePath);
    const verify = importResult.ok ? await verifyAndMarkDelta(gamePath) : { verified: false, reason: 'import_failed' };
    const data: DownloadedAsset = {
      assetId: uid,
      source: 'sketchfab',
      cachePath: cacheDir,
      files,
      imported: importResult.ok && verify.verified,
      importGamePath: gamePath,
      importNote: importResult.note,
      verified: verify.verified,
      verifyReason: verify.reason,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: `Sketchfab download error: ${msg}` }], isError: true };
  }
}
