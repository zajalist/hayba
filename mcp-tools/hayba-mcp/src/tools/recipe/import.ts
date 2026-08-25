// mcp-tools/hayba-mcp/src/tools/recipe/import.ts
//
// hayba_sliver_import — accepts either an absolute file path or an
// https URL, fetches the JSON, validates against the recipe schema,
// installs into userDir. Returns the installed id or a clear reason on
// failure. No network sandbox; trust is social — the LLM's caller (or
// the user) is responsible for vetting URLs.

import { z } from 'zod';
import { readFileSync, existsSync, statSync } from 'node:fs';
import type { RecipeLoader } from '../../recipes/loader.js';

export const recipeImportSchema = { source: z.string().min(1) };

export interface RecipeImportCtx { loader: RecipeLoader; }
export type RecipeImportResult =
  | { ok: true; id: string; path: string; source: string }
  | { ok: false; reason: string };

export async function recipeImportHandler(
  args: { source: string },
  ctx: RecipeImportCtx,
): Promise<RecipeImportResult> {
  let raw: string;
  try {
    if (/^https?:\/\//i.test(args.source)) {
      const resp = await fetch(args.source);
      if (!resp.ok) return { ok: false, reason: `fetch ${args.source} → HTTP ${resp.status}` };
      raw = await resp.text();
    } else if (existsSync(args.source) && statSync(args.source).isFile()) {
      raw = readFileSync(args.source, 'utf8');
    } else {
      return { ok: false, reason: `source must be an existing file path or an http(s) URL: "${args.source}"` };
    }
  } catch (e) {
    return { ok: false, reason: `read source: ${e instanceof Error ? e.message : String(e)}` };
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }; }

  const result = ctx.loader.install(parsed);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, id: result.id, path: result.path, source: args.source };
}

export const meta = {
  cost: 'medium' as const,
  effects: ['filesystem_write'],
  when: 'You want to install a recipe from a local file path or an http(s) URL into the user recipe library.',
  not_when: 'You only want to run an already-installed recipe — use hayba_sliver_run.',
  pack: 'core',
};
