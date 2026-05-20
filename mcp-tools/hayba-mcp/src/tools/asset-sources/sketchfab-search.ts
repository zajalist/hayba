import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'searching Sketchfab for downloadable 3D models (requires SKETCHFAB_API_TOKEN env var)',
  not_when: 'you already have a Sketchfab uid — go straight to sketchfab_download',
};

export const schema = z.object({
  query: z.string().min(1),
  downloadable: z.boolean().default(true),
  count: z.number().int().min(1).max(48).default(24),
});
export type SketchfabSearchParams = z.infer<typeof schema>;

const API = 'https://api.sketchfab.com/v3';

export function buildSearchUrl(p: SketchfabSearchParams): string {
  const qs = new URLSearchParams();
  qs.set('type', 'models');
  qs.set('q', p.query);
  qs.set('downloadable', String(p.downloadable));
  qs.set('archives_flavours', 'true');
  qs.set('count', String(p.count));
  return `${API}/search?${qs.toString()}`;
}

export function tokenMissingMessage(): string {
  return 'SKETCHFAB_API_TOKEN env var is not set. Get a token at https://sketchfab.com/settings/password (API tokens section) and export SKETCHFAB_API_TOKEN before invoking this tool.';
}

export async function handleSketchfabSearch(params: SketchfabSearchParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const token = process.env.SKETCHFAB_API_TOKEN;
  if (!token) {
    return { content: [{ type: 'text' as const, text: tokenMissingMessage() }], isError: true };
  }
  try {
    const url = buildSearchUrl(parsed.data);
    const res = await fetch(url, { headers: { Authorization: `Token ${token}` } });
    if (!res.ok) {
      return { content: [{ type: 'text' as const, text: `Sketchfab search failed: ${res.status} ${res.statusText}` }], isError: true };
    }
    const raw = (await res.json()) as any;
    const items = Array.isArray(raw?.results) ? raw.results : [];
    const results = items.map((m: any) => ({
      uid: m?.uid,
      name: m?.name,
      thumbnail: m?.thumbnails?.images?.[0]?.url ?? null,
      license: m?.license?.label ?? null,
      viewerUrl: m?.viewerUrl ?? null,
      archives: m?.archives ?? null,
      downloadable: m?.isDownloadable ?? false,
    }));
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ source: 'sketchfab', count: results.length, next: raw?.next ?? null, results }, null, 2),
      }],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: `Sketchfab search error: ${msg}` }], isError: true };
  }
}
