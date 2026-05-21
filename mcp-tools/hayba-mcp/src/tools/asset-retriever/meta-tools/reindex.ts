import type { AssetRetriever, ReindexResult } from '../asset-retriever.js';

export const assetReindexSchema = {};

export interface AssetReindexCtx { retriever: AssetRetriever; }

export async function assetReindexHandler(_args: Record<string, never>, ctx: AssetReindexCtx): Promise<ReindexResult> {
  return ctx.retriever.reindex();
}

export const meta = {
  cost: 'medium' as const,
  effects: ['rebuild_index'],
  when: 'The user just imported a batch of new assets outside the MCP-tracked download flow.',
  not_when: 'You just called a connector download — the retriever auto-deltas those.',
  pack: 'core',
};
