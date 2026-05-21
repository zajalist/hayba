import { z } from 'zod';
import type { SliverLoader } from '../../slivers/loader.js';

export const sliverListSchema = {
  category: z.string().optional(),
  namespace: z.string().optional(),
};

export interface SliverListCtx { loader: SliverLoader; }
export interface SliverSummary { id: string; title: string; category: string; version: string; }
export interface SliverListResult { slivers: SliverSummary[]; }

export async function sliverListHandler(
  args: { category?: string; namespace?: string },
  ctx: SliverListCtx,
): Promise<SliverListResult> {
  const slivers = ctx.loader.list()
    .filter(s => !args.category || s.category === args.category)
    .filter(s => !args.namespace || s.id.startsWith(args.namespace + '.') || s.id === args.namespace)
    .map(s => ({ id: s.id, title: s.title, category: s.category, version: s.version }));
  return { slivers };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want to discover which Slivers (deterministic abstractions) are installed.',
  not_when: 'You already know the sliver id and just want its full spec — use hayba_sliver_get.',
  pack: 'core',
};
