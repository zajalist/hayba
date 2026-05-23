//
// One-shot wiring: builds the registry, registers built-in executors,
// constructs the loader (which seeds + reads userDir), constructs the
// runtime. Caller (tools/routing/register.ts) holds the returned handle
// for use by the MCP sliver tools.

import { ExecutorRegistry } from './registry.js';
import { SliverLoader, defaultUserSliversDir } from './loader.js';
import { SliverRuntime } from './runtime.js';
import { COMPOSITION_FRAME_TARGET_KIND, frameTargetExecutor } from './composition/frame_target.js';
import { SCATTER_PCG_BIOME_KIND, pcgBiomeExecutor } from './scatter/pcg_biome.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SliverSystem {
  registry: ExecutorRegistry;
  loader: SliverLoader;
  runtime: SliverRuntime;
}

export interface SetupOpts {
  userDir?: string;
  bundledDir?: string;
  maxDepth?: number;
  onRun?: import('./runtime.js').SliverOnRun;
  /** UE bridge for side-effecting executors. Production wiring adapts
   *  `executeCommand`; tests can pass mock bridges or omit entirely. */
  ueBridge?: import('./types.js').SliverUeBridge;
}

export async function setupSliverSystem(opts: SetupOpts = {}): Promise<SliverSystem> {
  const registry = new ExecutorRegistry();
  registry.register(COMPOSITION_FRAME_TARGET_KIND, frameTargetExecutor);
  registry.register(SCATTER_PCG_BIOME_KIND, pcgBiomeExecutor);

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const loader = new SliverLoader({
    userDir: opts.userDir ?? defaultUserSliversDir(),
    bundledDir: opts.bundledDir ?? resolve(__dirname, 'specs'),
  });
  await loader.reload();

  const runtime = new SliverRuntime({
    registry,
    getSpec: (id) => loader.get(id),
    maxDepth: opts.maxDepth ?? 8,
    onRun: opts.onRun,
    ueBridge: opts.ueBridge,
  });

  return { registry, loader, runtime };
}

export type { SliverSpec, SliverRunResult, SliverParam, SliverParamValues } from './types.js';
export { SliverLoader, defaultUserSliversDir } from './loader.js';
export { SliverRuntime } from './runtime.js';
export { ExecutorRegistry } from './registry.js';
