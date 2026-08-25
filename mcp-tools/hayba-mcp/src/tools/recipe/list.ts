import { z } from 'zod';
import type { RecipeLoader } from '../../recipes/loader.js';

export const recipeListSchema = {
  category: z.string().optional(),
  namespace: z.string().optional(),
};

export interface RecipeListCtx { loader: RecipeLoader; }
export interface RecipeSummary { id: string; title: string; category: string; version: string; }
export interface RecipeListResult { recipes: RecipeSummary[]; }

export async function recipeListHandler(
  args: { category?: string; namespace?: string },
  ctx: RecipeListCtx,
): Promise<RecipeListResult> {
  const recipes = ctx.loader.list()
    .filter(s => !args.category || s.category === args.category)
    .filter(s => !args.namespace || s.id.startsWith(args.namespace + '.') || s.id === args.namespace)
    .map(s => ({ id: s.id, title: s.title, category: s.category, version: s.version }));
  return { recipes };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want to discover which Recipes (deterministic abstractions) are installed.',
  not_when: 'You already know the recipe id and just want its full spec — use hayba_sliver_get.',
  pack: 'core',
};
