// mcp-tools/hayba-mcp/src/recipes/types.ts
//
// Recipe type definitions. The runtime, loader, registry, and MCP tools
// all consume these. Discriminated-union params live here; the Zod
// equivalent is mirrored in spec-schema.ts for JSON validation.

export type RecipeParamBase = {
  id: string;
  label?: string;
  required?: boolean;
};

export type RecipeParamFloat   = RecipeParamBase & { type: 'float';     range?: [number, number]; step?: number; default?: number };
export type RecipeParamInt     = RecipeParamBase & { type: 'int';       range?: [number, number]; step?: number; default?: number };
export type RecipeParamBool    = RecipeParamBase & { type: 'bool';                                                default?: boolean };
export type RecipeParamString  = RecipeParamBase & { type: 'string';    maxLength?: number;                       default?: string };
export type RecipeParamEnum    = RecipeParamBase & { type: 'enum';      options: Array<{ value: string; label?: string }>; default?: string };
export type RecipeParamColor   = RecipeParamBase & { type: 'color';                                               default?: string };  // '#RRGGBB'
export type RecipeParamActor   = RecipeParamBase & { type: 'actor_ref'; class_filter?: string };
export type RecipeParamAsset   = RecipeParamBase & { type: 'asset_ref'; class_filter?: string };
export type RecipeParamVec3    = RecipeParamBase & { type: 'vector3';   range?: Array<[number, number]>;          default?: [number, number, number] };
export type RecipeParamXform   = RecipeParamBase & { type: 'transform'; default?: { location: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } };

export type RecipeParam =
  | RecipeParamFloat | RecipeParamInt | RecipeParamBool | RecipeParamString
  | RecipeParamEnum | RecipeParamColor | RecipeParamActor | RecipeParamAsset
  | RecipeParamVec3 | RecipeParamXform;

export interface RecipeDeterminism {
  pure: boolean;
  declared_outputs: string[];
  side_effects: string[];
  reads: string[];
  seed_param: string | null;
}

/** A single PLUMB constraint a recipe requires to hold. Mirrors a plumb
 *  Constraint minus the library id (one is derived per requirement). Binds to
 *  an asset path or a tag — "this tree must have these values when using this
 *  recipe". Evaluated (unioned with the asset's profile constraints) before the
 *  recipe's side effects are allowed to commit. */
export interface RecipeRequirement {
  primitive: string;                  // a plumb closed-set primitive id
  params?: Record<string, unknown>;
  binding: { asset?: string; tag?: { axis: string; value: string } };
  hard?: boolean;
  note?: string;
}

export interface RecipeSpec {
  id: string;
  version: string;
  category: string;
  title: string;
  description: string;
  author: string;
  params: RecipeParam[];
  executor: { kind: string };
  determinism: RecipeDeterminism;
  /** PLUMB constraints this recipe requires (optional). */
  requires?: RecipeRequirement[];
}

export type RecipeParamValues = Record<string, unknown>;

export interface RecipeRunResult {
  ok: boolean;
  outputs: Record<string, unknown>;
  side_effects: string[];
  durationMs: number;
  error?: string;
}

/** Structured return shape for an executor's dispatched UE command — always
 *  resolved (never throws), so a side-effecting executor can branch on `ok`. */
export interface RecipeDispatchResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Bridge wired by setupRecipeSystem when the host has a live UE connection
 *  (the production wiring adapts `executeCommand`). Pure executors leave
 *  ctx.dispatch undefined; side-effecting ones use it. */
export type RecipeUeBridge = (
  cmd: string,
  params: Record<string, unknown>,
) => Promise<RecipeDispatchResult>;

/** Context threaded through a runRecipe call. Mostly the runtime needs it; executors may read it. */
export interface RecipeContext {
  /** Reverse-DNS ids in the current call stack (oldest → newest). */
  stack: string[];
  /** Current depth = stack.length. Compared against maxDepth. */
  maxDepth: number;
  /** Lets executors call other recipes. */
  runRecipe: (id: string, params: RecipeParamValues) => Promise<RecipeRunResult>;
  /** Optional UE bridge for side-effecting executors. Undefined when the
   *  runtime was constructed without a bridge (the default — keeps pure
   *  recipes unit-testable without UE). */
  dispatch?: RecipeUeBridge;
}

/** Executor function signature. Pure or mutating per the spec's determinism block. */
export type RecipeExecutor = (
  params: RecipeParamValues,
  ctx: RecipeContext,
) => Promise<Record<string, unknown>>;

// ── Errors ───────────────────────────────────────────────────────────────────

export class RecipeCycleError extends Error {
  readonly name = 'RecipeCycleError';
  constructor(public readonly id: string, public readonly stack_ids: string[]) {
    super(`Recipe cycle detected — "${id}" re-entered its own call stack: ${stack_ids.join(' → ')}`);
  }
}

export class RecipeDepthError extends Error {
  readonly name = 'RecipeDepthError';
  constructor(public readonly maxDepth: number) {
    super(`Recipe call depth exceeded maxDepth=${maxDepth}`);
  }
}

export class RecipeNotFoundError extends Error {
  readonly name = 'RecipeNotFoundError';
  constructor(public readonly id: string) {
    super(`No installed recipe with id "${id}"`);
  }
}

export class RecipeValidationError extends Error {
  readonly name = 'RecipeValidationError';
  constructor(message: string) {
    super(message);
  }
}
