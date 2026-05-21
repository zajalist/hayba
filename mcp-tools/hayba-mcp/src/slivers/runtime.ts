// mcp-tools/hayba-mcp/src/slivers/runtime.ts
//
// SliverRuntime.runSliver — single entry point for executing any sliver.
// Walks: lookup spec → validate params → resolve executor → cycle/depth
// guard → execute → collect outputs + side_effects → return.
//
// Design note: cycle and depth errors are thrown without being caught by
// inner runInternal frames — they propagate all the way to the root call's
// catch block. This ensures that an executor which calls ctx.runSliver and
// gets a cycle/depth error will not silently succeed after the nested await.

import {
  SliverCycleError, SliverDepthError, SliverNotFoundError, SliverValidationError,
  type SliverParamValues, type SliverRunResult, type SliverSpec, type SliverContext,
} from './types.js';
import type { ExecutorRegistry } from './registry.js';
import { validateAndCoerceParams } from './param-validator.js';

export interface SliverRuntimeOpts {
  registry: ExecutorRegistry;
  getSpec: (id: string) => SliverSpec | undefined;
  maxDepth?: number;
}

/** Marker so the root catch knows these should remain unhandled at inner frames. */
const STRUCTURAL_ERRORS = [SliverCycleError, SliverDepthError] as const;

function isStructural(e: unknown): e is SliverCycleError | SliverDepthError {
  return STRUCTURAL_ERRORS.some(Cls => e instanceof Cls);
}

export class SliverRuntime {
  private readonly registry: ExecutorRegistry;
  private readonly getSpec: (id: string) => SliverSpec | undefined;
  private readonly maxDepth: number;

  constructor(opts: SliverRuntimeOpts) {
    this.registry = opts.registry;
    this.getSpec = opts.getSpec;
    this.maxDepth = opts.maxDepth ?? 8;
  }

  /** Public entry point. Always resolves (never rejects). */
  runSliver(id: string, params: SliverParamValues): Promise<SliverRunResult> {
    return this.runRoot(id, params, []);
  }

  /**
   * Root frame: wraps _runFrame in a try/catch that converts ALL errors
   * (including cycle/depth that bubble up from deep frames) into a result.
   * A shared `effects` array is passed down through the call tree so all
   * frames (root + children) accumulate into a single list.
   */
  private async runRoot(
    id: string,
    params: SliverParamValues,
    stack: string[],
  ): Promise<SliverRunResult> {
    const t0 = performance.now();
    const effects: string[] = [];
    try {
      const outputs = await this._runFrame(id, params, stack, effects);
      return {
        ok: true,
        outputs,
        side_effects: dedup(effects),
        durationMs: Math.round(performance.now() - t0),
      };
    } catch (e) {
      return {
        ok: false,
        outputs: {},
        side_effects: [],
        durationMs: Math.round(performance.now() - t0),
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Inner frame: throws on all errors (structural and non-structural).
   * Structural errors (cycle/depth) bubble through executor awaits unchanged.
   * Non-structural errors bubble up to the nearest runRoot catch.
   * Pushes this spec's side_effects into the shared `effects` array before
   * executing, so they are recorded even if the executor triggers a child.
   */
  private async _runFrame(
    id: string,
    params: SliverParamValues,
    stack: string[],
    effects: string[],
  ): Promise<Record<string, unknown>> {
    if (stack.length >= this.maxDepth) throw new SliverDepthError(this.maxDepth);
    if (stack.includes(id)) throw new SliverCycleError(id, [...stack, id]);

    const spec = this.getSpec(id);
    if (!spec) throw new SliverNotFoundError(id);

    const executor = this.registry.get(spec.executor.kind);
    if (!executor) throw new SliverValidationError(`executor.kind "${spec.executor.kind}" not registered`);

    const v = validateAndCoerceParams(spec.params, params);
    if (!v.ok) throw new SliverValidationError(v.reason);

    // Record this frame's side_effects into the shared accumulator.
    for (const e of spec.determinism.side_effects) effects.push(e);

    const newStack = [...stack, id];
    const ctx: SliverContext = {
      stack: newStack,
      maxDepth: this.maxDepth,
      runSliver: (childId, childParams) =>
        this._runChildSliver(childId, childParams, newStack, effects),
    };

    return await executor(v.values, ctx);
  }

  /**
   * Called by ctx.runSliver inside executors. Structural errors (cycle/depth)
   * are re-thrown so they escape the executor's try/catch and reach the root.
   * Non-structural errors are wrapped in a SliverRunResult.
   * The shared `effects` array is threaded through so child side_effects are
   * collected into the root accumulator.
   */
  private async _runChildSliver(
    id: string,
    params: SliverParamValues,
    stack: string[],
    effects: string[],
  ): Promise<SliverRunResult> {
    const t0 = performance.now();
    try {
      const outputs = await this._runFrame(id, params, stack, effects);
      const spec = this.getSpec(id);
      return {
        ok: true,
        outputs,
        side_effects: spec ? [...spec.determinism.side_effects] : [],
        durationMs: Math.round(performance.now() - t0),
      };
    } catch (e) {
      // Structural errors must not be swallowed here — re-throw so they
      // propagate through the executor's await chain to the root catch.
      if (isStructural(e)) throw e;
      return {
        ok: false,
        outputs: {},
        side_effects: [],
        durationMs: Math.round(performance.now() - t0),
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

/** Deduplicate a string array preserving first-seen order. */
function dedup(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}
