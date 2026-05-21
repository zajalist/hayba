import { z } from 'zod';
import type { AssetRetriever } from '../asset-retriever.js';
import type { Page } from '../asset-catalog.js';

export const assetBrowseSchema = {
  filter: z.object({
    path: z.string().optional(),
    class: z.string().optional(),
    tag: z.string().optional(),
    source: z.enum(['project', 'polyhaven', 'ambientcg', 'sketchfab', 'fab', 'unknown']).optional(),
  }).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};

export interface AssetBrowseCtx { retriever: AssetRetriever; }

export async function assetBrowseHandler(
  args: { filter?: { path?: string; class?: string; tag?: string; source?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' }; offset?: number; limit?: number },
  ctx: AssetBrowseCtx,
): Promise<Page> {
  return ctx.retriever.browse(args.filter ?? {}, args.offset ?? 0, args.limit ?? 50);
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want to enumerate assets by filter (path prefix, class, tag, source) without semantic ranking.',
  not_when: 'You have a semantic query — use hayba_asset_search.',
  pack: 'core',
};
