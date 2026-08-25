import { z } from 'zod';
import type { RecipeLoader } from '../../recipes/loader.js';

/**
 * Offer, and install, the bundled starter Recipes.
 *
 * The IA makes seeding a decision: "Optional: seed the Library with starter
 * Recipes" and "The optional seed choice must be explicit". The loader used to
 * install them on first run instead, which meant the choice was never offered
 * AND the teaching empty state a fresh install should show could never appear
 * — the Library was full before anyone looked at it.
 *
 * So the loader no longer installs anything by itself, and this is how the
 * choice gets made. Listing is separate from installing on purpose: a caller
 * can show what is on offer without committing the user to it.
 */

export const recipeStartersSchema = {
  /** Install them. Omitted or false only reports what is available. */
  install: z.boolean().optional(),
};

export interface RecipeStartersCtx { loader: RecipeLoader; }

export interface RecipeStartersResult {
  /** Bundled starters the user does not have. Empty once they are installed. */
  available: string[];
  /** What this call installed. Empty when only listing. */
  installed: string[];
  /** True when nothing is bundled at all, so a caller can say "none shipped"
   *  rather than "you already have them all" — different facts. */
  none_bundled: boolean;
}

export async function recipeStartersHandler(
  args: { install?: boolean },
  ctx: RecipeStartersCtx,
): Promise<RecipeStartersResult> {
  const before = ctx.loader.availableStarters();

  if (!args.install) {
    return {
      available: before,
      installed: [],
      // Nothing available AND nothing installed means nothing shipped. If the
      // user already has them, list() is non-empty.
      none_bundled: before.length === 0 && ctx.loader.list().length === 0,
    };
  }

  const installed = await ctx.loader.seedStarterRecipes();
  return {
    available: ctx.loader.availableStarters(),
    installed,
    none_bundled: before.length === 0 && installed.length === 0
      && ctx.loader.list().length === 0,
  };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read', 'write'],
  when: 'The Library is empty and the user wants the bundled starter Recipes, or you want to know what starters are on offer without installing them.',
  not_when: 'The user has not asked. Installing Recipes nobody requested is exactly what this replaced.',
  pack: 'core',
};
