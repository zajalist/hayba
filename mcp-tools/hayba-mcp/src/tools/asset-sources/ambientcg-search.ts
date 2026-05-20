import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'searching ambientCG for CC0 PBR materials, decals, or 3D models',
  not_when: 'you already know the asset id — go straight to ambientcg_download',
};

export const schema = z.object({
  query: z.string().min(1),
  type: z.string().default('Material').describe('ambientCG asset type (Material, Atlas, Decal, 3DModel, …)'),
  limit: z.number().int().min(1).max(100).default(20),
});
export type AmbientCgSearchParams = z.infer<typeof schema>;

const API = 'https://ambientCG.com/api/v2';

export function buildSearchUrl(p: AmbientCgSearchParams): string {
  const qs = new URLSearchParams();
  qs.set('type', p.type);
  qs.set('q', p.query);
  qs.set('limit', String(p.limit));
  return `${API}/full_json?${qs.toString()}`;
}

export async function handleAmbientCgSearch(params: AmbientCgSearchParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  try {
    const url = buildSearchUrl(parsed.data);
    const res = await fetch(url);
    if (!res.ok) {
      return { content: [{ type: 'text' as const, text: `ambientCG search failed: ${res.status} ${res.statusText}` }], isError: true };
    }
    const raw = (await res.json()) as Record<string, any>;
    const found = Array.isArray(raw?.foundAssets) ? raw.foundAssets : [];
    const results = found.map((a: any) => ({
      id: a?.assetId,
      title: a?.displayName ?? a?.assetId,
      thumbnail: a?.previewImage?.['512-PNG'] ?? a?.previewImage?.['512'] ?? a?.previewImage?.['256-PNG'] ?? null,
      license: 'CC0',
      tags: a?.tags ?? [],
      category: a?.category ?? null,
    }));
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ source: 'ambientcg', count: results.length, results }, null, 2),
      }],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: `ambientCG search error: ${msg}` }], isError: true };
  }
}
