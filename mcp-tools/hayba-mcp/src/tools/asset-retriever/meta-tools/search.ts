import { z } from 'zod';
import type { AssetRetriever } from '../asset-retriever.js';
import type { SearchHit } from '../asset-index.js';

export const assetSearchSchema = {
  query: z.string().min(1),
  k: z.number().int().min(1).max(50).optional(),
  filterClass: z.string().optional(),
  filterSource: z.enum(['project', 'polyhaven', 'ambientcg', 'sketchfab', 'fab', 'unknown']).optional(),
};

export interface AssetSearchCtx { retriever: AssetRetriever; }
export interface AssetSearchResult { hits: SearchHit[]; }

export async function assetSearchHandler(
  args: { query: string; k?: number; filterClass?: string; filterSource?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' },
  ctx: AssetSearchCtx,
): Promise<AssetSearchResult> {
  const hits = await ctx.retriever.search(args.query, {
    k: args.k ?? 8,
    filterClass: args.filterClass,
    filterSource: args.filterSource,
  });
  return { hits };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You need to find an asset in the user\'s UE Content Browser by semantic intent or keyword.',
  not_when: 'You need to download a new asset from an external catalog — use hayba_polyhaven_search etc. instead.',
  pack: 'core',
};
