import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'searching Poly Haven for CC0 HDRIs, textures, or models',
  not_when: 'you already know the exact asset slug — go straight to polyhaven_download',
};

export const schema = z.object({
  query: z.string().min(1),
  type: z.enum(['hdris', 'textures', 'models']).default('textures'),
  categories: z.string().optional().describe('Comma-separated Poly Haven category filter'),
});
export type PolyhavenSearchParams = z.infer<typeof schema>;

const API = 'https://api.polyhaven.com';

export function buildSearchUrl(p: PolyhavenSearchParams): string {
  const qs = new URLSearchParams();
  qs.set('type', p.type);
  if (p.query) qs.set('search', p.query);
  if (p.categories) qs.set('categories', p.categories);
  return `${API}/assets?${qs.toString()}`;
}

export async function handlePolyhavenSearch(params: PolyhavenSearchParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  try {
    const url = buildSearchUrl(parsed.data);
    const res = await fetch(url);
    if (!res.ok) {
      return { content: [{ type: 'text' as const, text: `Poly Haven search failed: ${res.status} ${res.statusText}` }], isError: true };
    }
    const raw = (await res.json()) as Record<string, any>;
    const results = Object.entries(raw).map(([id, info]) => ({
      id,
      title: info?.name ?? id,
      thumbnail: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256`,
      license: 'CC0',
      tags: info?.tags ?? [],
      categories: info?.categories ?? [],
      type: parsed.data.type,
    }));
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ source: 'polyhaven', count: results.length, results }, null, 2),
      }],
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: `Poly Haven search error: ${msg}` }], isError: true };
  }
}
