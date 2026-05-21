import { z } from 'zod';
import type { ToolIndex, SearchHit } from '../tool-index.js';

export const searchToolsSchema = {
  query: z.string().min(1),
  k: z.number().int().min(1).max(20).optional(),
  filterPack: z.string().optional(),
};

export interface SearchToolsCtx { index: ToolIndex; }
export interface SearchToolsResult { hits: SearchHit[]; }

export async function searchToolsHandler(
  args: { query: string; k?: number; filterPack?: string },
  ctx: SearchToolsCtx,
): Promise<SearchToolsResult> {
  const hits = await ctx.index.search(args.query, { k: args.k ?? 8, filterPack: args.filterPack });
  return { hits };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You need to find a tool by capability before loading a pack or invoking.',
  not_when: 'You already know the exact tool name — call hayba_get_tool_signature instead.',
  pack: 'core',
};
