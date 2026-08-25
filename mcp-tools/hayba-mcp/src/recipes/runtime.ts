// mcp-tools/hayba-mcp/src/recipes/runtime.ts
//
// RecipeRuntime.runRecipe — single entry point for executing any recipe.
// Walks: lookup spec → validate params → resolve executor → cycle/depth
// guard → execute → collect outputs + side_effects → return.
//
// Design note: cycle and depth errors are thrown without being caught by
// inner runInternal frames — they propagate all the way to the root call's
// catch block. This ensures that an executor which calls ctx.runRecipe and
// gets a cycle/depth error will not silently succeed after the nested await.

import {
  RecipeCycleError, RecipeDepthError, RecipeNotFoundError, RecipeValidationError,
  type RecipeParamValues, type RecipeRunResult, type RecipeSpec, type RecipeContext,
  type RecipeUeBridge, type RecipeVerdict,
} from './types.js';
import type { ExecutorRegistry } from './registry.js';
import { validateAndCoerceParams } from './param-validator.js';
import { checkRecipeRequires } from './requires.js';
import { constraintsFor } from '../plumb/index.js';
import type { InstanceState } from '../plumb/contracts.js';

export interface RecipeRunInfo {
  recipeId: string;
  params: RecipeParamValues;
  declaredReads: string[];
  writes: string[];
  ok: boolean;
}

export type RecipeOnRun = (info: RecipeRunInfo) => void;

export interface RecipeRuntimeOpts {
  registry: ExecutorRegistry;
  getSpec: (id: string) => RecipeSpec | undefined;
  maxDepth?: number;
  onRun?: RecipeOnRun;
  /** Bridge that side-effecting executors use to call UE commands via
   *  ctx.dispatch. Undefined → ctx.dispatch is undefined and only pure
   *  executors are usable. The production wiring adapts `executeCommand`;
   *  tests pass mock bridges. */
  ueBridge?: RecipeUeBridge;
}

/** Marker so the root catch knows these should remain unhandled at inner frames. */
const STRUCTURAL_ERRORS = [RecipeCycleError, RecipeDepthError] as const;

function isStructural(e: unknown): e is RecipeCycleError | RecipeDepthError {
  return STRUCTURAL_ERRORS.some(Cls => e instanceof Cls);
}

export class RecipeRuntime {
  private readonly registry: ExecutorRegistry;
  private readonly getSpec: (id: string) => RecipeSpec | undefined;
  private readonly maxDepth: number;
  private readonly onRun?: RecipeOnRun;
  private readonly ueBridge?: RecipeUeBridge;

  constructor(opts: RecipeRuntimeOpts) {
    this.registry = opts.registry;
    this.getSpec = opts.getSpec;
    this.maxDepth = opts.maxDepth ?? 8;
    this.onRun = opts.onRun;
    this.ueBridge = opts.ueBridge;
  }

  /** Public entry point. Always resolves (never rejects). */
  runRecipe(id: string, params: RecipeParamValues): Promise<RecipeRunResult> {
    return this.runRoot(id, params, []);
  }

  /**
   * Root frame: wraps _runFrame in a try/catch that converts ALL errors
   * (including cycle/depth that bubble up from deep frames) into a result.
   * A shared `effects` array is passed down through the call tree so all
   * frames (root + children) accumulate into a single list. `placed` is
   * threaded the same way, so a recipe that delegates its placement to a child
   * still gets judged on what the child actually put in the world.
   */
  private async runRoot(
    id: string,
    params: RecipeParamValues,
    stack: string[],
  ): Promise<RecipeRunResult> {
    const t0 = performance.now();
    const effects: string[] = [];
    const placed: InstanceState[] = [];
    let result: RecipeRunResult;
    try {
      const outputs = await this._runFrame(id, params, stack, effects, placed);
      result = {
        ok: true,
        outputs,
        side_effects: dedup(effects),
        durationMs: Math.round(performance.now() - t0),
        verdict: this.judge(id, placed),
      };
    } catch (e) {
      result = {
        ok: false,
        outputs: {},
        side_effects: [],
        durationMs: Math.round(performance.now() - t0),
        error: e instanceof Error ? e.message : String(e),
      };
    }

    if (this.onRun) {
      const spec = this.getSpec(id);
      this.onRun({
        recipeId: id,
        params,
        declaredReads: spec ? spec.determinism.reads : [],
        writes: result.side_effects,
        ok: result.ok,
      });
    }
    return result;
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
    params: RecipeParamValues,
    stack: string[],
    effects: string[],
    placed: InstanceState[],
  ): Promise<Record<string, unknown>> {
    if (stack.length >= this.maxDepth) throw new RecipeDepthError(this.maxDepth);
    if (stack.includes(id)) throw new RecipeCycleError(id, [...stack, id]);

    const spec = this.getSpec(id);
    if (!spec) throw new RecipeNotFoundError(id);

    const executor = this.registry.get(spec.executor.kind);
    if (!executor) throw new RecipeValidationError(`executor.kind "${spec.executor.kind}" not registered`);

    const v = validateAndCoerceParams(spec.params, params);
    if (!v.ok) throw new RecipeValidationError(v.reason);

    // Record this frame's side_effects into the shared accumulator.
    for (const e of spec.determinism.side_effects) effects.push(e);

    const newStack = [...stack, id];
    const ctx: RecipeContext = {
      stack: newStack,
      maxDepth: this.maxDepth,
      runRecipe: (childId, childParams) =>
        this._runChildRecipe(childId, childParams, newStack, effects, placed),
      dispatch: this.ueBridge,
      placed: (instances) => { placed.push(...instances); },
    };

    return await executor(v.values, ctx);
  }

  /**
   * Called by ctx.runRecipe inside executors. Structural errors (cycle/depth)
   * are re-thrown so they escape the executor's try/catch and reach the root.
   * Non-structural errors are wrapped in a RecipeRunResult.
   * The shared `effects` array is threaded through so child side_effects are
   * collected into the root accumulator.
   */
  private async _runChildRecipe(
    id: string,
    params: RecipeParamValues,
    stack: string[],
    effects: string[],
    placed: InstanceState[],
  ): Promise<RecipeRunResult> {
    const t0 = performance.now();
    try {
      const outputs = await this._runFrame(id, params, stack, effects, placed);
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

  /**
   * Judge what the run put in the world against what the recipe promised.
   *
   * This is the point of the whole exercise: a user should never have to
   * navigate somewhere else to find out whether an edit was sound. The answer
   * comes back attached to the edit.
   *
   * Returning `undefined` means there was nothing to judge -- no declared
   * requirements and no bound constraints. That is different from `checked:
   * false`, which means there WAS something to judge and it could not be
   * looked at. Collapsing those two would turn "I couldn't check" into "it's
   * fine", which is the failure this codebase already refuses elsewhere.
   */
  private judge(id: string, placed: InstanceState[]): RecipeVerdict | undefined {
    const spec = this.getSpec(id);
    if (!spec) return undefined;

    const declares = (spec.requires ?? []).length > 0;
    const bound = placed.some(i => constraintsFor(i.asset, i.tags).length > 0);
    if (!declares && !bound) return undefined;

    if (placed.length === 0) {
      return {
        checked: false,
        reason: declares
          ? `"${id}" declares ${spec.requires!.length} requirement(s) but its executor reported no instances, so nothing was checked.`
          : `"${id}" has bound constraints but reported no instances, so nothing was checked.`,
      };
    }

    try {
      return { checked: true, plumb: checkRecipeRequires(spec, placed) };
    } catch (e) {
      // A thrown evaluator must not turn a successful edit into a failed one,
      // but it must not read as a pass either.
      return {
        checked: false,
        reason: `Evaluating requirements threw: ${e instanceof Error ? e.message : String(e)}`,
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
