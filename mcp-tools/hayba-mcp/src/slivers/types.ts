// mcp-tools/hayba-mcp/src/slivers/types.ts
//
// Sliver type definitions. The runtime, loader, registry, and MCP tools
// all consume these. Discriminated-union params live here; the Zod
// equivalent is mirrored in spec-schema.ts for JSON validation.

export type SliverParamBase = {
  id: string;
  label?: string;
  required?: boolean;
};

export type SliverParamFloat   = SliverParamBase & { type: 'float';     range?: [number, number]; step?: number; default?: number };
export type SliverParamInt     = SliverParamBase & { type: 'int';       range?: [number, number]; step?: number; default?: number };
export type SliverParamBool    = SliverParamBase & { type: 'bool';                                                default?: boolean };
export type SliverParamString  = SliverParamBase & { type: 'string';    maxLength?: number;                       default?: string };
export type SliverParamEnum    = SliverParamBase & { type: 'enum';      options: Array<{ value: string; label?: string }>; default?: string };
export type SliverParamColor   = SliverParamBase & { type: 'color';                                               default?: string };  // '#RRGGBB'
export type SliverParamActor   = SliverParamBase & { type: 'actor_ref'; class_filter?: string };
export type SliverParamAsset   = SliverParamBase & { type: 'asset_ref'; class_filter?: string };
export type SliverParamVec3    = SliverParamBase & { type: 'vector3';   range?: Array<[number, number]>;          default?: [number, number, number] };
export type SliverParamXform   = SliverParamBase & { type: 'transform'; default?: { location: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } };

export type SliverParam =
  | SliverParamFloat | SliverParamInt | SliverParamBool | SliverParamString
  | SliverParamEnum | SliverParamColor | SliverParamActor | SliverParamAsset
  | SliverParamVec3 | SliverParamXform;

export interface SliverDeterminism {
  pure: boolean;
  declared_outputs: string[];
  side_effects: string[];
  reads: string[];
  seed_param: string | null;
}

export interface SliverSpec {
  id: string;
  version: string;
  category: string;
  title: string;
  description: string;
  author: string;
  params: SliverParam[];
  executor: { kind: string };
  determinism: SliverDeterminism;
}

export type SliverParamValues = Record<string, unknown>;

export interface SliverRunResult {
  ok: boolean;
  outputs: Record<string, unknown>;
  side_effects: string[];
  durationMs: number;
  error?: string;
}

/** Structured return shape for an executor's dispatched UE command — always
 *  resolved (never throws), so a side-effecting executor can branch on `ok`. */
export interface SliverDispatchResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/** Bridge wired by setupSliverSystem when the host has a live UE connection
 *  (the production wiring adapts `executeCommand`). Pure executors leave
 *  ctx.dispatch undefined; side-effecting ones use it. */
export type SliverUeBridge = (
  cmd: string,
  params: Record<string, unknown>,
) => Promise<SliverDispatchResult>;

/** Context threaded through a runSliver call. Mostly the runtime needs it; executors may read it. */
export interface SliverContext {
  /** Reverse-DNS ids in the current call stack (oldest → newest). */
  stack: string[];
  /** Current depth = stack.length. Compared against maxDepth. */
  maxDepth: number;
  /** Lets executors call other slivers. */
  runSliver: (id: string, params: SliverParamValues) => Promise<SliverRunResult>;
  /** Optional UE bridge for side-effecting executors. Undefined when the
   *  runtime was constructed without a bridge (the default — keeps pure
   *  slivers unit-testable without UE). */
  dispatch?: SliverUeBridge;
}

/** Executor function signature. Pure or mutating per the spec's determinism block. */
export type SliverExecutor = (
  params: SliverParamValues,
  ctx: SliverContext,
) => Promise<Record<string, unknown>>;

// ── Errors ───────────────────────────────────────────────────────────────────

export class SliverCycleError extends Error {
  readonly name = 'SliverCycleError';
  constructor(public readonly id: string, public readonly stack_ids: string[]) {
    super(`Sliver cycle detected — "${id}" re-entered its own call stack: ${stack_ids.join(' → ')}`);
  }
}

export class SliverDepthError extends Error {
  readonly name = 'SliverDepthError';
  constructor(public readonly maxDepth: number) {
    super(`Sliver call depth exceeded maxDepth=${maxDepth}`);
  }
}

export class SliverNotFoundError extends Error {
  readonly name = 'SliverNotFoundError';
  constructor(public readonly id: string) {
    super(`No installed sliver with id "${id}"`);
  }
}

export class SliverValidationError extends Error {
  readonly name = 'SliverValidationError';
  constructor(message: string) {
    super(message);
  }
}
