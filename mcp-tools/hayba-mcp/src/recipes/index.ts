//
// One-shot wiring: builds the registry, registers built-in executors,
// constructs the loader (which seeds + reads userDir), constructs the
// runtime. Caller (tools/routing/register.ts) holds the returned handle
// for use by the MCP recipe tools.

import { ExecutorRegistry } from './registry.js';
import { RecipeLoader, defaultUserRecipesDir, legacyUserRecipesDir, migrateLegacyLibrary } from './loader.js';
import { RecipeRuntime } from './runtime.js';
import { COMPOSITION_FRAME_TARGET_KIND, frameTargetExecutor } from './composition/frame_target.js';
import { SCATTER_PCG_BIOME_KIND, pcgBiomeExecutor } from './scatter/pcg_biome.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RecipeSystem {
  registry: ExecutorRegistry;
  loader: RecipeLoader;
  runtime: RecipeRuntime;
}

export interface SetupOpts {
  userDir?: string;
  bundledDir?: string;
  maxDepth?: number;
  onRun?: import('./runtime.js').RecipeOnRun;
  /** UE bridge for side-effecting executors. Production wiring adapts
   *  `executeCommand`; tests can pass mock bridges or omit entirely. */
  ueBridge?: import('./types.js').RecipeUeBridge;
}

export async function setupRecipeSystem(opts: SetupOpts = {}): Promise<RecipeSystem> {
  const registry = new ExecutorRegistry();
  registry.register(COMPOSITION_FRAME_TARGET_KIND, frameTargetExecutor);
  registry.register(SCATTER_PCG_BIOME_KIND, pcgBiomeExecutor);

  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Only for the real library. A caller that names its own userDir (tests,
  // and anything pointing at a scratch directory) gets exactly that.
  if (!opts.userDir) {
    const r = migrateLegacyLibrary(legacyUserRecipesDir(), defaultUserRecipesDir());
    if (r.moved) console.warn('[recipes] moved the recipe library to its new home (Hayba/recipes)');
  }

  const loader = new RecipeLoader({
    userDir: opts.userDir ?? defaultUserRecipesDir(),
    bundledDir: opts.bundledDir ?? resolve(__dirname, 'specs'),
  });
  await loader.reload();

  const runtime = new RecipeRuntime({
    registry,
    getSpec: (id) => loader.get(id),
    maxDepth: opts.maxDepth ?? 8,
    onRun: opts.onRun,
    ueBridge: opts.ueBridge,
  });

  return { registry, loader, runtime };
}

export type { RecipeSpec, RecipeRunResult, RecipeParam, RecipeParamValues } from './types.js';
export { RecipeLoader, defaultUserRecipesDir } from './loader.js';
export { RecipeRuntime } from './runtime.js';
export { ExecutorRegistry } from './registry.js';
