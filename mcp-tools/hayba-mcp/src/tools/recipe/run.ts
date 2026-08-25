// mcp-tools/hayba-mcp/src/tools/recipe/run.ts
import { z } from 'zod';
import type { RecipeRuntime } from '../../recipes/runtime.js';
import type { RecipeRunResult } from '../../recipes/types.js';

export const recipeRunSchema = {
  id: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
};

export interface RecipeRunCtx { runtime: RecipeRuntime; }

export async function recipeRunHandler(
  args: { id: string; params: Record<string, unknown> },
  ctx: RecipeRunCtx,
): Promise<RecipeRunResult> {
  return ctx.runtime.runRecipe(args.id, args.params ?? {});
}

export const meta = {
  cost: 'medium' as const,
  effects: ['varies-by-recipe'],
  when: 'You want to execute a recipe with concrete parameter values. Returns outputs + declared side_effects.',
  not_when: 'You only need to read the spec — use hayba_sliver_get.',
  pack: 'core',
};
