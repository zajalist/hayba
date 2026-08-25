import { z } from 'zod';
import type { RecipeLoader } from '../../recipes/loader.js';
import type { RecipeSpec } from '../../recipes/types.js';

export const recipeGetSchema = { id: z.string().min(1) };

export interface RecipeGetCtx { loader: RecipeLoader; }
export type RecipeGetResult =
  | { found: true; spec: RecipeSpec }
  | { found: false; id: string };

export async function recipeGetHandler(
  args: { id: string },
  ctx: RecipeGetCtx,
): Promise<RecipeGetResult> {
  const spec = ctx.loader.get(args.id);
  if (!spec) return { found: false, id: args.id };
  return { found: true, spec };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You have a recipe id and need its full spec — param schema, determinism block, executor kind.',
  not_when: 'You want to enumerate recipes — use hayba_sliver_list.',
  pack: 'core',
};
