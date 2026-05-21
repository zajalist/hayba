# Slivers v1 Plan A — TS Runtime + MCP Tools + frame_target

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Sliver runtime, four always-on MCP tools (`hayba_sliver_{list,get,run,import}`), and one bundled sliver (`com.hayba.composition.frame_target`). After this plan, an LLM can list, fetch, execute, and import slivers without any UE plugin work.

**Architecture:** TS-side discriminated-union `SliverSpec` validated by Zod, executor functions registered against `executor.kind` strings, runtime with per-invocation cycle detection + max depth + side-effect aggregation. Specs live as JSON in `%APPDATA%/Hayba/slivers/`. Built-in specs ship inside the package and are copied to disk on first run if missing. MCP tool surface is added to `ALWAYS_ON_META` and registered alongside the existing asset-retriever tools.

**Tech Stack:** TypeScript 5, Vitest, Zod, `@modelcontextprotocol/sdk`. Node 22 (the repo's `package.json` engines). No UE-side work in this plan.

**Spec reference:** `docs/superpowers/specs/2026-05-21-slivers-design.md`.

---

## File Structure

```
mcp-tools/hayba-mcp/
├── src/
│   ├── slivers/
│   │   ├── types.ts                         # SliverSpec, SliverParam discriminated union, errors
│   │   ├── spec-schema.ts                   # Zod schema mirroring types.ts for JSON validation
│   │   ├── registry.ts                      # executor registration by kind
│   │   ├── runtime.ts                       # runSliver(id, params, ctx) with cycle/depth guards
│   │   ├── loader.ts                        # reads + writes %APPDATA%/Hayba/slivers/*.sliver.json
│   │   ├── index.ts                         # setupSliverSystem() facade
│   │   ├── composition/
│   │   │   └── frame_target.ts              # pure executor; returns camera_transform
│   │   ├── specs/
│   │   │   └── com.hayba.composition.frame_target.sliver.json
│   │   ├── types.test.ts
│   │   ├── spec-schema.test.ts
│   │   ├── registry.test.ts
│   │   ├── runtime.test.ts
│   │   ├── loader.test.ts
│   │   └── composition/
│   │       └── frame_target.test.ts
│   ├── tools/
│   │   └── sliver/
│   │       ├── list.ts                      # hayba_sliver_list handler + schema
│   │       ├── get.ts                       # hayba_sliver_get handler + schema
│   │       ├── run.ts                       # hayba_sliver_run handler + schema
│   │       ├── import.ts                    # hayba_sliver_import handler + schema
│   │       ├── list.test.ts
│   │       ├── get.test.ts
│   │       ├── run.test.ts
│   │       └── import.test.ts
│   └── tools/routing/register.ts            # modified: add slivers to ALWAYS_ON_META + wire 4 tools
└── package.json                             # modified: build:assets copies sliver specs
```

Each file has one responsibility. Tests live next to source per the existing repo convention (`*.test.ts` siblings).

---

### Task 1: Sliver type definitions

**Files:**
- Create: `mcp-tools/hayba-mcp/src/slivers/types.ts`
- Test: `mcp-tools/hayba-mcp/src/slivers/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/slivers/types.test.ts
import { describe, it, expect } from 'vitest';
import { SliverCycleError, SliverDepthError, SliverNotFoundError, SliverValidationError } from './types.js';

describe('sliver error types', () => {
  it('SliverCycleError carries the offending id and the call stack', () => {
    const err = new SliverCycleError('com.hayba.a', ['com.hayba.b', 'com.hayba.a']);
    expect(err.name).toBe('SliverCycleError');
    expect(err.id).toBe('com.hayba.a');
    expect(err.stack_ids).toEqual(['com.hayba.b', 'com.hayba.a']);
    expect(err.message).toContain('com.hayba.a');
  });

  it('SliverDepthError reports the depth that was exceeded', () => {
    const err = new SliverDepthError(8);
    expect(err.maxDepth).toBe(8);
    expect(err.message).toContain('8');
  });

  it('SliverNotFoundError carries the missing id', () => {
    expect(new SliverNotFoundError('com.x.y').id).toBe('com.x.y');
  });

  it('SliverValidationError keeps the human reason', () => {
    expect(new SliverValidationError('missing required param "target"').message).toContain('target');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/types.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the types module**

```ts
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

/** Context threaded through a runSliver call. Mostly the runtime needs it; executors may read it. */
export interface SliverContext {
  /** Reverse-DNS ids in the current call stack (oldest → newest). */
  stack: string[];
  /** Current depth = stack.length. Compared against maxDepth. */
  maxDepth: number;
  /** Lets executors call other slivers. */
  runSliver: (id: string, params: SliverParamValues) => Promise<SliverRunResult>;
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
    super(`Sliver "${id}" re-entered its own call stack: ${stack_ids.join(' → ')}`);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/types.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/slivers/types.ts mcp-tools/hayba-mcp/src/slivers/types.test.ts
git commit -m "feat(slivers): type definitions for spec, params, runtime, errors"
```

---

### Task 2: Zod schema for JSON spec validation

**Files:**
- Create: `mcp-tools/hayba-mcp/src/slivers/spec-schema.ts`
- Test: `mcp-tools/hayba-mcp/src/slivers/spec-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/slivers/spec-schema.test.ts
import { describe, it, expect } from 'vitest';
import { sliverSpecSchema, parseSliverSpec } from './spec-schema.js';

const valid = {
  id: 'com.hayba.composition.frame_target',
  version: '1.0.0',
  category: 'composition',
  title: 'Frame Target',
  description: 'Compute a camera transform.',
  author: 'core',
  params: [
    { id: 'target', type: 'actor_ref', required: true },
    { id: 'distance', type: 'float', range: [1, 100], default: 10 },
  ],
  executor: { kind: 'composition.frame_target' },
  determinism: { pure: true, declared_outputs: ['camera_transform'], side_effects: [], seed_param: null },
};

describe('sliver spec schema', () => {
  it('accepts a valid spec', () => {
    expect(() => sliverSpecSchema.parse(valid)).not.toThrow();
  });

  it('parseSliverSpec returns ok=true on valid input', () => {
    const r = parseSliverSpec(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.id).toBe(valid.id);
  });

  it('parseSliverSpec returns ok=false with reason on bad input', () => {
    const r = parseSliverSpec({ ...valid, id: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/id/i);
  });

  it('rejects ids that are not reverse-DNS', () => {
    const r = parseSliverSpec({ ...valid, id: 'frame_target' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown param types', () => {
    const r = parseSliverSpec({
      ...valid,
      params: [{ id: 'x', type: 'banana' as unknown as 'float' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate param ids', () => {
    const r = parseSliverSpec({
      ...valid,
      params: [
        { id: 'a', type: 'float' },
        { id: 'a', type: 'int' },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/duplicate/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/spec-schema.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the schema module**

```ts
// mcp-tools/hayba-mcp/src/slivers/spec-schema.ts
//
// Zod schema mirroring the TS types in types.ts. Used to validate JSON
// specs loaded from disk and from URL imports. The discriminated union
// on `type` matches the SliverParam shape exactly.

import { z } from 'zod';
import type { SliverSpec } from './types.js';

const reverseDns = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

const rangePair = z.tuple([z.number(), z.number()]);

const paramBase = { id: z.string().min(1), label: z.string().optional(), required: z.boolean().optional() };

const paramFloat   = z.object({ ...paramBase, type: z.literal('float'),     range: rangePair.optional(), step: z.number().optional(), default: z.number().optional() });
const paramInt     = z.object({ ...paramBase, type: z.literal('int'),       range: rangePair.optional(), step: z.number().optional(), default: z.number().int().optional() });
const paramBool    = z.object({ ...paramBase, type: z.literal('bool'),      default: z.boolean().optional() });
const paramString  = z.object({ ...paramBase, type: z.literal('string'),    maxLength: z.number().int().positive().optional(), default: z.string().optional() });
const paramEnum    = z.object({ ...paramBase, type: z.literal('enum'),      options: z.array(z.object({ value: z.string(), label: z.string().optional() })).min(1), default: z.string().optional() });
const paramColor   = z.object({ ...paramBase, type: z.literal('color'),     default: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });
const paramActor   = z.object({ ...paramBase, type: z.literal('actor_ref'), class_filter: z.string().optional() });
const paramAsset   = z.object({ ...paramBase, type: z.literal('asset_ref'), class_filter: z.string().optional() });
const paramVec3    = z.object({ ...paramBase, type: z.literal('vector3'),   range: z.array(rangePair).length(3).optional(), default: z.tuple([z.number(), z.number(), z.number()]).optional() });
const paramXform   = z.object({ ...paramBase, type: z.literal('transform'), default: z.object({
  location: z.tuple([z.number(), z.number(), z.number()]),
  rotation: z.tuple([z.number(), z.number(), z.number()]),
  scale:    z.tuple([z.number(), z.number(), z.number()]),
}).optional() });

const param = z.discriminatedUnion('type', [
  paramFloat, paramInt, paramBool, paramString, paramEnum,
  paramColor, paramActor, paramAsset, paramVec3, paramXform,
]);

const determinism = z.object({
  pure: z.boolean(),
  declared_outputs: z.array(z.string()),
  side_effects: z.array(z.string()),
  seed_param: z.string().nullable(),
});

export const sliverSpecSchema = z.object({
  id: z.string().regex(reverseDns, 'id must be reverse-DNS like com.hayba.composition.frame_target'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver MAJOR.MINOR.PATCH'),
  category: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  author: z.string().min(1),
  params: z.array(param).superRefine((arr, ctx) => {
    const seen = new Set<string>();
    for (const p of arr) {
      if (seen.has(p.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate param id "${p.id}"` });
      }
      seen.add(p.id);
    }
  }),
  executor: z.object({ kind: z.string().min(1) }),
  determinism,
});

export type ParseResult =
  | { ok: true; spec: SliverSpec }
  | { ok: false; reason: string };

export function parseSliverSpec(input: unknown): ParseResult {
  const r = sliverSpecSchema.safeParse(input);
  if (r.success) return { ok: true, spec: r.data as SliverSpec };
  const first = r.error.issues[0];
  const path = first.path.join('.') || '(root)';
  return { ok: false, reason: `${path}: ${first.message}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/spec-schema.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/slivers/spec-schema.ts mcp-tools/hayba-mcp/src/slivers/spec-schema.test.ts
git commit -m "feat(slivers): zod schema for spec JSON validation"
```

---

### Task 3: Executor registry

**Files:**
- Create: `mcp-tools/hayba-mcp/src/slivers/registry.ts`
- Test: `mcp-tools/hayba-mcp/src/slivers/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/slivers/registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutorRegistry } from './registry.js';
import type { SliverExecutor } from './types.js';

describe('ExecutorRegistry', () => {
  let reg: ExecutorRegistry;
  beforeEach(() => { reg = new ExecutorRegistry(); });

  it('register + get round-trips', () => {
    const fn: SliverExecutor = async () => ({ ok: true });
    reg.register('composition.frame_target', fn);
    expect(reg.get('composition.frame_target')).toBe(fn);
  });

  it('returns undefined for unknown kind', () => {
    expect(reg.get('does.not.exist')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const fn: SliverExecutor = async () => ({});
    reg.register('k', fn);
    expect(() => reg.register('k', fn)).toThrow(/already registered/);
  });

  it('lists registered kinds', () => {
    reg.register('a', async () => ({}));
    reg.register('b', async () => ({}));
    expect(reg.kinds().sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/registry.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the registry**

```ts
// mcp-tools/hayba-mcp/src/slivers/registry.ts
//
// Maps executor.kind strings to executor functions. Each category
// (composition, lighting, pcg_diff, …) registers one entry per concrete
// sliver. Slivers loaded from disk look up their executor here at run
// time; a missing kind is a clear "executor not bundled" error.

import type { SliverExecutor } from './types.js';

export class ExecutorRegistry {
  private readonly byKind = new Map<string, SliverExecutor>();

  register(kind: string, executor: SliverExecutor): void {
    if (this.byKind.has(kind)) {
      throw new Error(`Executor kind "${kind}" already registered`);
    }
    this.byKind.set(kind, executor);
  }

  get(kind: string): SliverExecutor | undefined {
    return this.byKind.get(kind);
  }

  kinds(): string[] {
    return [...this.byKind.keys()];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/registry.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/slivers/registry.ts mcp-tools/hayba-mcp/src/slivers/registry.test.ts
git commit -m "feat(slivers): executor registry keyed by executor.kind"
```

---

### Task 4: Param validator (used by runtime)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/slivers/param-validator.ts`
- Test: `mcp-tools/hayba-mcp/src/slivers/param-validator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/slivers/param-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateAndCoerceParams } from './param-validator.js';
import type { SliverParam } from './types.js';

const params: SliverParam[] = [
  { id: 'distance', type: 'float', range: [1, 100], default: 10 },
  { id: 'pick',     type: 'enum',  options: [{ value: 'a' }, { value: 'b' }], default: 'a' },
  { id: 'on',       type: 'bool',  default: false },
  { id: 'target',   type: 'actor_ref', required: true },
];

describe('validateAndCoerceParams', () => {
  it('fills defaults when values are omitted', () => {
    const r = validateAndCoerceParams(params, { target: '/Game/X.X' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values).toEqual({ distance: 10, pick: 'a', on: false, target: '/Game/X.X' });
  });

  it('fails when a required param is missing', () => {
    const r = validateAndCoerceParams(params, { distance: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/target/);
  });

  it('rejects out-of-range floats', () => {
    const r = validateAndCoerceParams(params, { target: '/Game/X.X', distance: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/distance/);
  });

  it('rejects enum values not in options', () => {
    const r = validateAndCoerceParams(params, { target: '/Game/X.X', pick: 'z' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/pick/);
  });

  it('rejects wrong types', () => {
    const r = validateAndCoerceParams(params, { target: '/Game/X.X', distance: 'big' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown param ids', () => {
    const r = validateAndCoerceParams(params, { target: '/Game/X.X', wat: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/wat/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/param-validator.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the validator**

```ts
// mcp-tools/hayba-mcp/src/slivers/param-validator.ts
//
// Runtime validation + default-filling for a SliverParam[] against a
// caller-supplied values bag. Centralised so the MCP `run` tool and
// internal runSliver calls share one code path.

import type { SliverParam, SliverParamValues } from './types.js';

export type ValidateResult =
  | { ok: true; values: SliverParamValues }
  | { ok: false; reason: string };

export function validateAndCoerceParams(
  params: SliverParam[],
  input: SliverParamValues,
): ValidateResult {
  const known = new Set(params.map(p => p.id));
  for (const k of Object.keys(input)) {
    if (!known.has(k)) return { ok: false, reason: `unknown param "${k}"` };
  }

  const out: SliverParamValues = {};
  for (const p of params) {
    const provided = Object.prototype.hasOwnProperty.call(input, p.id);
    let v = provided ? input[p.id] : (('default' in p ? (p as { default?: unknown }).default : undefined));

    if (v === undefined) {
      if (p.required) return { ok: false, reason: `missing required param "${p.id}"` };
      continue;
    }

    const err = checkParam(p, v);
    if (err) return { ok: false, reason: `param "${p.id}": ${err}` };
    out[p.id] = v;
  }
  return { ok: true, values: out };
}

function checkParam(p: SliverParam, v: unknown): string | null {
  switch (p.type) {
    case 'float':
    case 'int': {
      if (typeof v !== 'number' || Number.isNaN(v)) return `expected number, got ${typeof v}`;
      if (p.type === 'int' && !Number.isInteger(v)) return 'expected integer';
      if (p.range) {
        const [lo, hi] = p.range;
        if (v < lo || v > hi) return `out of range [${lo}, ${hi}]`;
      }
      return null;
    }
    case 'bool':
      return typeof v === 'boolean' ? null : `expected boolean, got ${typeof v}`;
    case 'string':
      if (typeof v !== 'string') return `expected string, got ${typeof v}`;
      if (p.maxLength != null && v.length > p.maxLength) return `exceeds maxLength=${p.maxLength}`;
      return null;
    case 'enum':
      if (typeof v !== 'string') return 'expected string';
      return p.options.some(o => o.value === v) ? null : `not in options`;
    case 'color':
      return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? null : 'expected "#RRGGBB" hex';
    case 'actor_ref':
    case 'asset_ref':
      return typeof v === 'string' && v.length > 0 ? null : 'expected non-empty path string';
    case 'vector3':
      if (!Array.isArray(v) || v.length !== 3 || !v.every(n => typeof n === 'number')) return 'expected [x,y,z] number tuple';
      return null;
    case 'transform':
      if (typeof v !== 'object' || v === null) return 'expected object';
      // shallow check; the executor is trusted to deep-validate if it cares
      return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/param-validator.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/slivers/param-validator.ts mcp-tools/hayba-mcp/src/slivers/param-validator.test.ts
git commit -m "feat(slivers): runtime param validator with defaults + ranges"
```

---

### Task 5: Sliver runtime (runSliver with cycle detection)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/slivers/runtime.ts`
- Test: `mcp-tools/hayba-mcp/src/slivers/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/slivers/runtime.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutorRegistry } from './registry.js';
import { SliverRuntime } from './runtime.js';
import type { SliverSpec, SliverExecutor } from './types.js';

function makeSpec(id: string, kind: string, extra: Partial<SliverSpec> = {}): SliverSpec {
  return {
    id,
    version: '1.0.0',
    category: 'test',
    title: id,
    description: '',
    author: 'test',
    params: [],
    executor: { kind },
    determinism: { pure: true, declared_outputs: ['v'], side_effects: [], seed_param: null },
    ...extra,
  };
}

describe('SliverRuntime.runSliver', () => {
  let registry: ExecutorRegistry;
  let runtime: SliverRuntime;
  let specs: Map<string, SliverSpec>;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    specs = new Map();
    runtime = new SliverRuntime({
      registry,
      getSpec: (id) => specs.get(id),
      maxDepth: 8,
    });
  });

  it('returns the executor output and durationMs', async () => {
    specs.set('com.t.a', makeSpec('com.t.a', 'k.a'));
    registry.register('k.a', async () => ({ v: 42 }));
    const r = await runtime.runSliver('com.t.a', {});
    expect(r.ok).toBe(true);
    expect(r.outputs).toEqual({ v: 42 });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns SliverNotFoundError shape when spec is missing', async () => {
    const r = await runtime.runSliver('com.t.missing', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/com\.t\.missing/);
  });

  it('returns error when executor.kind is not registered', async () => {
    specs.set('com.t.x', makeSpec('com.t.x', 'k.unregistered'));
    const r = await runtime.runSliver('com.t.x', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/k\.unregistered/);
  });

  it('validates params against the spec', async () => {
    specs.set('com.t.p', makeSpec('com.t.p', 'k.p', {
      params: [{ id: 'x', type: 'float', range: [0, 1] }],
    }));
    registry.register('k.p', async () => ({}));
    const r = await runtime.runSliver('com.t.p', { x: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/out of range/);
  });

  it('aggregates declared side_effects into the result', async () => {
    specs.set('com.t.s', makeSpec('com.t.s', 'k.s', {
      determinism: { pure: false, declared_outputs: [], side_effects: ['lighting_change'], seed_param: null },
    }));
    registry.register('k.s', async () => ({}));
    const r = await runtime.runSliver('com.t.s', {});
    expect(r.side_effects).toEqual(['lighting_change']);
  });

  it('detects direct cycles (sliver calls itself)', async () => {
    specs.set('com.t.cyc', makeSpec('com.t.cyc', 'k.cyc'));
    const exec: SliverExecutor = async (_p, ctx) => {
      await ctx.runSliver('com.t.cyc', {});
      return {};
    };
    registry.register('k.cyc', exec);
    const r = await runtime.runSliver('com.t.cyc', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cycle/i);
  });

  it('detects indirect cycles (a → b → a)', async () => {
    specs.set('com.t.a', makeSpec('com.t.a', 'k.a'));
    specs.set('com.t.b', makeSpec('com.t.b', 'k.b'));
    registry.register('k.a', async (_p, ctx) => { await ctx.runSliver('com.t.b', {}); return {}; });
    registry.register('k.b', async (_p, ctx) => { await ctx.runSliver('com.t.a', {}); return {}; });
    const r = await runtime.runSliver('com.t.a', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cycle/i);
  });

  it('enforces maxDepth', async () => {
    const small = new SliverRuntime({ registry, getSpec: (id) => specs.get(id), maxDepth: 2 });
    specs.set('com.t.deep', makeSpec('com.t.deep', 'k.deep'));
    let i = 0;
    registry.register('k.deep', async (_p, ctx) => {
      if (i++ < 5) await ctx.runSliver('com.t.deep2', {});
      return {};
    });
    specs.set('com.t.deep2', makeSpec('com.t.deep2', 'k.deep2'));
    registry.register('k.deep2', async (_p, ctx) => {
      if (i++ < 5) await ctx.runSliver('com.t.deep', {});
      return {};
    });
    const r = await small.runSliver('com.t.deep', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/depth/i);
  });

  it('allows the same sliver to be called sequentially (no false cycle)', async () => {
    specs.set('com.t.leaf', makeSpec('com.t.leaf', 'k.leaf'));
    specs.set('com.t.par',  makeSpec('com.t.par',  'k.par'));
    registry.register('k.leaf', async () => ({ v: 1 }));
    registry.register('k.par', async (_p, ctx) => {
      const a = await ctx.runSliver('com.t.leaf', {});
      const b = await ctx.runSliver('com.t.leaf', {});
      return { a: a.outputs.v, b: b.outputs.v };
    });
    const r = await runtime.runSliver('com.t.par', {});
    expect(r.ok).toBe(true);
    expect(r.outputs).toEqual({ a: 1, b: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/runtime.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the runtime**

```ts
// mcp-tools/hayba-mcp/src/slivers/runtime.ts
//
// SliverRuntime.runSliver — single entry point for executing any sliver.
// Walks: lookup spec → validate params → resolve executor → cycle/depth
// guard → execute → collect outputs + side_effects → return.

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

export class SliverRuntime {
  private readonly registry: ExecutorRegistry;
  private readonly getSpec: (id: string) => SliverSpec | undefined;
  private readonly maxDepth: number;

  constructor(opts: SliverRuntimeOpts) {
    this.registry = opts.registry;
    this.getSpec = opts.getSpec;
    this.maxDepth = opts.maxDepth ?? 8;
  }

  runSliver(id: string, params: SliverParamValues): Promise<SliverRunResult> {
    return this.runInternal(id, params, []);
  }

  private async runInternal(
    id: string,
    params: SliverParamValues,
    stack: string[],
  ): Promise<SliverRunResult> {
    const t0 = performance.now();
    try {
      if (stack.length >= this.maxDepth) throw new SliverDepthError(this.maxDepth);
      if (stack.includes(id)) throw new SliverCycleError(id, [...stack, id]);

      const spec = this.getSpec(id);
      if (!spec) throw new SliverNotFoundError(id);

      const executor = this.registry.get(spec.executor.kind);
      if (!executor) throw new SliverValidationError(`executor.kind "${spec.executor.kind}" not registered`);

      const v = validateAndCoerceParams(spec.params, params);
      if (!v.ok) throw new SliverValidationError(v.reason);

      const newStack = [...stack, id];
      const ctx: SliverContext = {
        stack: newStack,
        maxDepth: this.maxDepth,
        runSliver: (childId, childParams) => this.runInternal(childId, childParams, newStack),
      };

      const outputs = await executor(v.values, ctx);

      return {
        ok: true,
        outputs,
        side_effects: [...spec.determinism.side_effects],
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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/runtime.test.ts`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/slivers/runtime.ts mcp-tools/hayba-mcp/src/slivers/runtime.test.ts
git commit -m "feat(slivers): runSliver with cycle detection, depth limit, side-effect aggregation"
```

---

### Task 6: Spec loader (disk read + bundled fallback)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/slivers/loader.ts`
- Test: `mcp-tools/hayba-mcp/src/slivers/loader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/slivers/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SliverLoader } from './loader.js';

const validSpec = {
  id: 'com.test.demo',
  version: '1.0.0',
  category: 'test',
  title: 'Demo',
  description: '',
  author: 'test',
  params: [],
  executor: { kind: 'test.demo' },
  determinism: { pure: true, declared_outputs: [], side_effects: [], seed_param: null },
};

describe('SliverLoader', () => {
  let userDir: string;
  let bundledDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sliver-user-'));
    bundledDir = mkdtempSync(join(tmpdir(), 'hayba-sliver-bundled-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(bundledDir, { recursive: true, force: true });
  });

  it('loads valid specs from userDir', async () => {
    writeFileSync(join(userDir, 'com.test.demo.sliver.json'), JSON.stringify(validSpec));
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.list().map(s => s.id)).toEqual(['com.test.demo']);
    expect(loader.get('com.test.demo')?.title).toBe('Demo');
  });

  it('seeds userDir from bundledDir on first reload if userDir lacks the spec', async () => {
    writeFileSync(join(bundledDir, 'com.test.demo.sliver.json'), JSON.stringify(validSpec));
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    expect(existsSync(join(userDir, 'com.test.demo.sliver.json'))).toBe(true);
    expect(loader.get('com.test.demo')).toBeDefined();
  });

  it('userDir wins over bundledDir when both have the same id', async () => {
    writeFileSync(join(bundledDir, 'com.test.demo.sliver.json'), JSON.stringify(validSpec));
    writeFileSync(join(userDir, 'com.test.demo.sliver.json'), JSON.stringify({ ...validSpec, title: 'User Override' }));
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.get('com.test.demo')?.title).toBe('User Override');
  });

  it('skips and logs invalid specs without failing the whole reload', async () => {
    writeFileSync(join(userDir, 'good.sliver.json'), JSON.stringify(validSpec));
    writeFileSync(join(userDir, 'bad.sliver.json'), '{ not valid json');
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.list().length).toBe(1);
    expect(loader.errors().length).toBe(1);
    expect(loader.errors()[0]).toMatch(/bad\.sliver\.json/);
  });

  it('install writes a spec to userDir and adds it to the in-memory map', async () => {
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    const r = loader.install(validSpec);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe('com.test.demo');
    expect(existsSync(join(userDir, 'com.test.demo.sliver.json'))).toBe(true);
    expect(loader.get('com.test.demo')).toBeDefined();
  });

  it('install rejects malformed specs', async () => {
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    const r = loader.install({ ...validSpec, id: 'not-reverse-dns' });
    expect(r.ok).toBe(false);
  });

  it('ignores non-sliver json files', async () => {
    writeFileSync(join(userDir, 'com.test.demo.preset.json'), JSON.stringify({ distance: 5 }));
    writeFileSync(join(userDir, 'README.md'), '# slivers');
    const loader = new SliverLoader({ userDir, bundledDir });
    await loader.reload();
    expect(loader.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/loader.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the loader**

```ts
// mcp-tools/hayba-mcp/src/slivers/loader.ts
//
// SliverLoader — reads *.sliver.json from %APPDATA%/Hayba/slivers/
// (userDir), seeding from the package's bundled specs (bundledDir) on
// first run. Validates with parseSliverSpec; bad files are skipped and
// reported via errors() so the MCP server keeps booting.
//
// "install" writes a new spec to userDir and updates the in-memory map.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SliverSpec } from './types.js';
import { parseSliverSpec } from './spec-schema.js';

export interface SliverLoaderOpts {
  /** Absolute path to %APPDATA%/Hayba/slivers/ (or test override). */
  userDir: string;
  /** Absolute path to the package's bundled specs (dist/slivers/specs/). */
  bundledDir: string;
}

export type InstallResult =
  | { ok: true; id: string; path: string }
  | { ok: false; reason: string };

const SUFFIX = '.sliver.json';

export class SliverLoader {
  private readonly userDir: string;
  private readonly bundledDir: string;
  private specs = new Map<string, SliverSpec>();
  private loadErrors: string[] = [];

  constructor(opts: SliverLoaderOpts) {
    this.userDir = opts.userDir;
    this.bundledDir = opts.bundledDir;
  }

  /** Seed (idempotent) then full reload from userDir. Call at startup or after import. */
  async reload(): Promise<void> {
    this.ensureDir(this.userDir);
    this.seedFromBundled();
    this.specs.clear();
    this.loadErrors = [];
    if (!existsSync(this.userDir)) return;
    for (const name of readdirSync(this.userDir)) {
      if (!name.endsWith(SUFFIX)) continue;
      const fullPath = join(this.userDir, name);
      try {
        const raw = readFileSync(fullPath, 'utf8');
        const json = JSON.parse(raw);
        const parsed = parseSliverSpec(json);
        if (!parsed.ok) {
          this.loadErrors.push(`${name}: ${parsed.reason}`);
          continue;
        }
        this.specs.set(parsed.spec.id, parsed.spec);
      } catch (e) {
        this.loadErrors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  list(): SliverSpec[] { return [...this.specs.values()]; }
  get(id: string): SliverSpec | undefined { return this.specs.get(id); }
  errors(): string[] { return [...this.loadErrors]; }

  install(specInput: unknown): InstallResult {
    const parsed = parseSliverSpec(specInput);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    this.ensureDir(this.userDir);
    const path = join(this.userDir, `${parsed.spec.id}${SUFFIX}`);
    writeFileSync(path, JSON.stringify(parsed.spec, null, 2));
    this.specs.set(parsed.spec.id, parsed.spec);
    return { ok: true, id: parsed.spec.id, path };
  }

  private ensureDir(dir: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private seedFromBundled(): void {
    if (!existsSync(this.bundledDir)) return;
    if (!statSync(this.bundledDir).isDirectory()) return;
    for (const name of readdirSync(this.bundledDir)) {
      if (!name.endsWith(SUFFIX)) continue;
      const target = join(this.userDir, name);
      if (existsSync(target)) continue;
      copyFileSync(join(this.bundledDir, name), target);
    }
  }
}

/** Default user dir resolver — %APPDATA%/Hayba/slivers on Windows, ~/.hayba/slivers elsewhere. */
export function defaultUserSliversDir(): string {
  const base = process.env.APPDATA ?? join(process.env.HOME ?? '.', '.hayba');
  return join(base, 'Hayba', 'slivers');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/loader.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/slivers/loader.ts mcp-tools/hayba-mcp/src/slivers/loader.test.ts
git commit -m "feat(slivers): disk loader with bundled-spec seeding and install"
```

---

### Task 7: `frame_target` executor + bundled spec

**Files:**
- Create: `mcp-tools/hayba-mcp/src/slivers/composition/frame_target.ts`
- Create: `mcp-tools/hayba-mcp/src/slivers/composition/frame_target.test.ts`
- Create: `mcp-tools/hayba-mcp/src/slivers/specs/com.hayba.composition.frame_target.sliver.json`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/slivers/composition/frame_target.test.ts
import { describe, it, expect } from 'vitest';
import { frameTargetExecutor, COMPOSITION_FRAME_TARGET_KIND } from './frame_target.js';
import type { SliverContext } from '../types.js';

const ctxStub: SliverContext = { stack: [], maxDepth: 8, runSliver: async () => ({ ok: true, outputs: {}, side_effects: [], durationMs: 0 }) };

describe('frameTargetExecutor', () => {
  it('returns a camera_transform object with location, rotation, and fov', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/Heroes/SK_Hero.SK_Hero',
      distance: 10,
      height: 2,
      fov: 70,
      yaw_deg: 0,
    }, ctxStub);
    expect(out).toHaveProperty('camera_transform');
    const t = out.camera_transform as { location: number[]; rotation: number[]; fov: number };
    expect(t.location).toHaveLength(3);
    expect(t.rotation).toHaveLength(3);
    expect(t.fov).toBe(70);
  });

  it('at yaw=0 places the camera on +X axis at the given distance', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/X.X', distance: 10, height: 0, fov: 70, yaw_deg: 0,
    }, ctxStub) as { camera_transform: { location: [number, number, number] } };
    expect(out.camera_transform.location[0]).toBeCloseTo(1000, 1); // 10m → 1000 UE units
    expect(out.camera_transform.location[1]).toBeCloseTo(0, 1);
  });

  it('at yaw=90 places the camera on +Y axis', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/X.X', distance: 10, height: 0, fov: 70, yaw_deg: 90,
    }, ctxStub) as { camera_transform: { location: [number, number, number] } };
    expect(out.camera_transform.location[0]).toBeCloseTo(0, 1);
    expect(out.camera_transform.location[1]).toBeCloseTo(1000, 1);
  });

  it('applies the height offset to Z (meters → centimetres)', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/X.X', distance: 10, height: 3, fov: 70, yaw_deg: 0,
    }, ctxStub) as { camera_transform: { location: [number, number, number] } };
    expect(out.camera_transform.location[2]).toBeCloseTo(300, 1);
  });

  it('points yaw toward the origin (camera at +X looks toward −X)', async () => {
    const out = await frameTargetExecutor({
      target: '/Game/X.X', distance: 10, height: 0, fov: 70, yaw_deg: 0,
    }, ctxStub) as { camera_transform: { rotation: [number, number, number] } };
    // rotation in [pitch, yaw, roll] degrees per UE convention
    expect(out.camera_transform.rotation[1]).toBeCloseTo(180, 1);
  });

  it('exports the registry kind as a constant', () => {
    expect(COMPOSITION_FRAME_TARGET_KIND).toBe('composition.frame_target');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/composition/frame_target.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the executor**

```ts
// mcp-tools/hayba-mcp/src/slivers/composition/frame_target.ts
//
// Pure executor: given a target actor path + distance/height/fov/orbit,
// returns a camera_transform pointing at the target's origin from a
// position on the orbit circle around it. Coordinates returned in UE
// units (centimetres); the caller (render_camera or similar) consumes
// the transform as-is.
//
// We don't resolve the actor's actual location here — that requires a
// UE round-trip. v1 frames toward the world origin from a relative
// offset; the LLM/agent is responsible for combining with the actor's
// world location if needed. A v2 could call a hayba_actor_location
// subroutine via ctx.runSliver.

import type { SliverExecutor } from '../types.js';

export const COMPOSITION_FRAME_TARGET_KIND = 'composition.frame_target';

interface FrameTargetParams {
  target: string;
  distance: number;
  height: number;
  fov: number;
  yaw_deg: number;
}

export const frameTargetExecutor: SliverExecutor = async (rawParams) => {
  const p = rawParams as unknown as FrameTargetParams;
  const M_TO_UE = 100;          // 1 m = 100 UE units
  const yawRad = (p.yaw_deg * Math.PI) / 180;
  const r = p.distance * M_TO_UE;

  const x = Math.cos(yawRad) * r;
  const y = Math.sin(yawRad) * r;
  const z = p.height * M_TO_UE;

  // Camera looks at origin: yaw is +180 from the position angle.
  const cameraYawDeg = (p.yaw_deg + 180) % 360;
  // Simple pitch toward the target accounting for height.
  const pitchDeg = Math.atan2(-z, r) * (180 / Math.PI);

  return {
    camera_transform: {
      location: [x, y, z],
      rotation: [pitchDeg, cameraYawDeg, 0],   // [pitch, yaw, roll]
      fov: p.fov,
    },
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/composition/frame_target.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Create the bundled JSON spec**

```json
// mcp-tools/hayba-mcp/src/slivers/specs/com.hayba.composition.frame_target.sliver.json
{
  "id": "com.hayba.composition.frame_target",
  "version": "1.0.0",
  "category": "composition",
  "title": "Frame Target",
  "description": "Compute a camera transform that frames a target actor from a given orbit angle, distance, and height offset.",
  "author": "core",
  "params": [
    { "id": "target",   "type": "actor_ref", "label": "Target",            "required": true },
    { "id": "distance", "type": "float",     "label": "Distance (m)",      "range": [1, 100],  "default": 10 },
    { "id": "height",   "type": "float",     "label": "Height offset (m)", "range": [-10, 50], "default": 2 },
    { "id": "fov",      "type": "float",     "label": "Field of view (deg)","range": [20, 120], "default": 70 },
    { "id": "yaw_deg",  "type": "float",     "label": "Orbit angle (deg)", "range": [0, 360],  "default": 45 }
  ],
  "executor": { "kind": "composition.frame_target" },
  "determinism": {
    "pure": true,
    "declared_outputs": ["camera_transform"],
    "side_effects": [],
    "seed_param": null
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add mcp-tools/hayba-mcp/src/slivers/composition/ mcp-tools/hayba-mcp/src/slivers/specs/
git commit -m "feat(slivers): frame_target executor + bundled spec"
```

---

### Task 8: `setupSliverSystem` facade

**Files:**
- Create: `mcp-tools/hayba-mcp/src/slivers/index.ts`
- Test: `mcp-tools/hayba-mcp/src/slivers/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/slivers/index.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSliverSystem } from './index.js';

describe('setupSliverSystem', () => {
  let userDir: string;
  let bundledDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sliver-sys-u-'));
    bundledDir = mkdtempSync(join(tmpdir(), 'hayba-sliver-sys-b-'));
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(bundledDir, { recursive: true, force: true });
  });

  it('wires loader + registry + runtime and registers built-in executors', async () => {
    const sys = await setupSliverSystem({ userDir, bundledDir, maxDepth: 4 });
    expect(sys.registry.kinds()).toContain('composition.frame_target');
    expect(sys.runtime).toBeDefined();
    expect(sys.loader).toBeDefined();
  });

  it('seeds the bundled frame_target spec into userDir when bundledDir contains it', async () => {
    const { copyFileSync, mkdirSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    mkdirSync(bundledDir, { recursive: true });
    copyFileSync(
      resolve('src/slivers/specs/com.hayba.composition.frame_target.sliver.json'),
      join(bundledDir, 'com.hayba.composition.frame_target.sliver.json'),
    );
    const sys = await setupSliverSystem({ userDir, bundledDir, maxDepth: 4 });
    expect(sys.loader.get('com.hayba.composition.frame_target')).toBeDefined();

    const r = await sys.runtime.runSliver('com.hayba.composition.frame_target', { target: '/Game/X.X' });
    expect(r.ok).toBe(true);
    expect(r.outputs).toHaveProperty('camera_transform');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/index.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the facade**

```ts
// mcp-tools/hayba-mcp/src/slivers/index.ts
//
// One-shot wiring: builds the registry, registers built-in executors,
// constructs the loader (which seeds + reads userDir), constructs the
// runtime. Caller (tools/routing/register.ts) holds the returned handle
// for use by the MCP sliver tools.

import { ExecutorRegistry } from './registry.js';
import { SliverLoader, defaultUserSliversDir } from './loader.js';
import { SliverRuntime } from './runtime.js';
import { COMPOSITION_FRAME_TARGET_KIND, frameTargetExecutor } from './composition/frame_target.js';
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
}

export async function setupSliverSystem(opts: SetupOpts = {}): Promise<SliverSystem> {
  const registry = new ExecutorRegistry();
  registry.register(COMPOSITION_FRAME_TARGET_KIND, frameTargetExecutor);

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
  });

  return { registry, loader, runtime };
}

export type { SliverSpec, SliverRunResult, SliverParam, SliverParamValues } from './types.js';
export { SliverLoader, defaultUserSliversDir } from './loader.js';
export { SliverRuntime } from './runtime.js';
export { ExecutorRegistry } from './registry.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/slivers/index.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/slivers/index.ts mcp-tools/hayba-mcp/src/slivers/index.test.ts
git commit -m "feat(slivers): setupSliverSystem facade wiring registry + loader + runtime"
```

---

### Task 9: `hayba_sliver_list` MCP tool

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/sliver/list.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/sliver/list.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/tools/sliver/list.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSliverSystem } from '../../slivers/index.js';
import { sliverListHandler } from './list.js';

describe('hayba_sliver_list', () => {
  let userDir: string;
  let sys: Awaited<ReturnType<typeof setupSliverSystem>>;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-list-'));
    sys = await setupSliverSystem({ userDir, bundledDir: 'src/slivers/specs', maxDepth: 4 });
  });
  afterEach(() => { rmSync(userDir, { recursive: true, force: true }); });

  it('returns all installed slivers', async () => {
    const r = await sliverListHandler({}, { loader: sys.loader });
    expect(r.slivers.length).toBeGreaterThan(0);
    expect(r.slivers[0]).toMatchObject({
      id: 'com.hayba.composition.frame_target',
      category: 'composition',
    });
  });

  it('filters by category', async () => {
    const r = await sliverListHandler({ category: 'composition' }, { loader: sys.loader });
    expect(r.slivers.every(s => s.category === 'composition')).toBe(true);
    const empty = await sliverListHandler({ category: 'does_not_exist' }, { loader: sys.loader });
    expect(empty.slivers).toEqual([]);
  });

  it('filters by namespace prefix', async () => {
    const r = await sliverListHandler({ namespace: 'com.hayba' }, { loader: sys.loader });
    expect(r.slivers.every(s => s.id.startsWith('com.hayba.'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/sliver/list.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the handler**

```ts
// mcp-tools/hayba-mcp/src/tools/sliver/list.ts
import { z } from 'zod';
import type { SliverLoader } from '../../slivers/loader.js';

export const sliverListSchema = {
  category: z.string().optional(),
  namespace: z.string().optional(),
};

export interface SliverListCtx { loader: SliverLoader; }
export interface SliverSummary { id: string; title: string; category: string; version: string; }
export interface SliverListResult { slivers: SliverSummary[]; }

export async function sliverListHandler(
  args: { category?: string; namespace?: string },
  ctx: SliverListCtx,
): Promise<SliverListResult> {
  const slivers = ctx.loader.list()
    .filter(s => !args.category || s.category === args.category)
    .filter(s => !args.namespace || s.id.startsWith(args.namespace + '.') || s.id === args.namespace)
    .map(s => ({ id: s.id, title: s.title, category: s.category, version: s.version }));
  return { slivers };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want to discover which Slivers (deterministic abstractions) are installed.',
  not_when: 'You already know the sliver id and just want its full spec — use hayba_sliver_get.',
  pack: 'core',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/sliver/list.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/sliver/list.ts mcp-tools/hayba-mcp/src/tools/sliver/list.test.ts
git commit -m "feat(slivers): hayba_sliver_list MCP tool"
```

---

### Task 10: `hayba_sliver_get` MCP tool

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/sliver/get.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/sliver/get.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/tools/sliver/get.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSliverSystem } from '../../slivers/index.js';
import { sliverGetHandler } from './get.js';

describe('hayba_sliver_get', () => {
  let userDir: string;
  let sys: Awaited<ReturnType<typeof setupSliverSystem>>;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-get-'));
    sys = await setupSliverSystem({ userDir, bundledDir: 'src/slivers/specs', maxDepth: 4 });
  });
  afterEach(() => { rmSync(userDir, { recursive: true, force: true }); });

  it('returns the full spec for a known id', async () => {
    const r = await sliverGetHandler({ id: 'com.hayba.composition.frame_target' }, { loader: sys.loader });
    expect(r.found).toBe(true);
    if (r.found) {
      expect(r.spec.id).toBe('com.hayba.composition.frame_target');
      expect(r.spec.params.length).toBeGreaterThan(0);
    }
  });

  it('returns found=false for unknown id', async () => {
    const r = await sliverGetHandler({ id: 'com.nope.missing' }, { loader: sys.loader });
    expect(r.found).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/sliver/get.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create the handler**

```ts
// mcp-tools/hayba-mcp/src/tools/sliver/get.ts
import { z } from 'zod';
import type { SliverLoader } from '../../slivers/loader.js';
import type { SliverSpec } from '../../slivers/types.js';

export const sliverGetSchema = { id: z.string().min(1) };

export interface SliverGetCtx { loader: SliverLoader; }
export type SliverGetResult =
  | { found: true; spec: SliverSpec }
  | { found: false; id: string };

export async function sliverGetHandler(
  args: { id: string },
  ctx: SliverGetCtx,
): Promise<SliverGetResult> {
  const spec = ctx.loader.get(args.id);
  if (!spec) return { found: false, id: args.id };
  return { found: true, spec };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You have a sliver id and need its full spec — param schema, determinism block, executor kind.',
  not_when: 'You want to enumerate slivers — use hayba_sliver_list.',
  pack: 'core',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/sliver/get.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/sliver/get.ts mcp-tools/hayba-mcp/src/tools/sliver/get.test.ts
git commit -m "feat(slivers): hayba_sliver_get MCP tool"
```

---

### Task 11: `hayba_sliver_run` MCP tool

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/sliver/run.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/sliver/run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/tools/sliver/run.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSliverSystem } from '../../slivers/index.js';
import { sliverRunHandler } from './run.js';

describe('hayba_sliver_run', () => {
  let userDir: string;
  let sys: Awaited<ReturnType<typeof setupSliverSystem>>;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-run-'));
    sys = await setupSliverSystem({ userDir, bundledDir: 'src/slivers/specs', maxDepth: 4 });
  });
  afterEach(() => { rmSync(userDir, { recursive: true, force: true }); });

  it('executes a known sliver and returns ok=true with outputs', async () => {
    const r = await sliverRunHandler(
      { id: 'com.hayba.composition.frame_target', params: { target: '/Game/X.X' } },
      { runtime: sys.runtime },
    );
    expect(r.ok).toBe(true);
    expect(r.outputs).toHaveProperty('camera_transform');
    expect(typeof r.durationMs).toBe('number');
  });

  it('returns ok=false with error message when sliver id is unknown', async () => {
    const r = await sliverRunHandler(
      { id: 'com.nope.missing', params: {} },
      { runtime: sys.runtime },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing/);
  });

  it('returns ok=false when params fail validation', async () => {
    const r = await sliverRunHandler(
      { id: 'com.hayba.composition.frame_target', params: { target: '/Game/X.X', distance: 9999 } },
      { runtime: sys.runtime },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/distance/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/sliver/run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create the handler**

```ts
// mcp-tools/hayba-mcp/src/tools/sliver/run.ts
import { z } from 'zod';
import type { SliverRuntime } from '../../slivers/runtime.js';
import type { SliverRunResult } from '../../slivers/types.js';

export const sliverRunSchema = {
  id: z.string().min(1),
  params: z.record(z.unknown()).default({}),
};

export interface SliverRunCtx { runtime: SliverRuntime; }

export async function sliverRunHandler(
  args: { id: string; params: Record<string, unknown> },
  ctx: SliverRunCtx,
): Promise<SliverRunResult> {
  return ctx.runtime.runSliver(args.id, args.params ?? {});
}

export const meta = {
  cost: 'medium' as const,
  effects: ['varies-by-sliver'],
  when: 'You want to execute a sliver with concrete parameter values. Returns outputs + declared side_effects.',
  not_when: 'You only need to read the spec — use hayba_sliver_get.',
  pack: 'core',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/sliver/run.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/sliver/run.ts mcp-tools/hayba-mcp/src/tools/sliver/run.test.ts
git commit -m "feat(slivers): hayba_sliver_run MCP tool"
```

---

### Task 12: `hayba_sliver_import` MCP tool

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/sliver/import.ts`
- Test: `mcp-tools/hayba-mcp/src/tools/sliver/import.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/tools/sliver/import.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSliverSystem } from '../../slivers/index.js';
import { sliverImportHandler } from './import.js';

const sample = {
  id: 'com.example.cool.thing',
  version: '1.0.0',
  category: 'demo',
  title: 'Cool Thing',
  description: 'demo',
  author: 'example',
  params: [],
  executor: { kind: 'demo.cool' },
  determinism: { pure: true, declared_outputs: [], side_effects: [], seed_param: null },
};

describe('hayba_sliver_import', () => {
  let userDir: string;
  let srcDir: string;
  let sys: Awaited<ReturnType<typeof setupSliverSystem>>;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-imp-u-'));
    srcDir  = mkdtempSync(join(tmpdir(), 'hayba-sl-imp-s-'));
    sys = await setupSliverSystem({ userDir, bundledDir: 'src/slivers/specs', maxDepth: 4 });
  });
  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('imports a local file path and installs it to userDir', async () => {
    const p = join(srcDir, 'cool.sliver.json');
    writeFileSync(p, JSON.stringify(sample));
    const r = await sliverImportHandler({ source: p }, { loader: sys.loader });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.id).toBe('com.example.cool.thing');
      expect(existsSync(join(userDir, 'com.example.cool.thing.sliver.json'))).toBe(true);
    }
    expect(sys.loader.get('com.example.cool.thing')).toBeDefined();
  });

  it('imports an https URL via fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(sample), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const r = await sliverImportHandler({ source: 'https://example.com/cool.sliver.json' }, { loader: sys.loader });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(r.ok).toBe(true);
  });

  it('rejects sources that are not file paths or https URLs', async () => {
    const r = await sliverImportHandler({ source: 'ftp://example.com/x' }, { loader: sys.loader });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/source/i);
  });

  it('rejects malformed JSON content', async () => {
    const p = join(srcDir, 'bad.sliver.json');
    writeFileSync(p, '{ not json');
    const r = await sliverImportHandler({ source: p }, { loader: sys.loader });
    expect(r.ok).toBe(false);
  });

  it('rejects specs that fail schema validation', async () => {
    const p = join(srcDir, 'bad.sliver.json');
    writeFileSync(p, JSON.stringify({ ...sample, id: 'not-reverse-dns' }));
    const r = await sliverImportHandler({ source: p }, { loader: sys.loader });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/sliver/import.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create the handler**

```ts
// mcp-tools/hayba-mcp/src/tools/sliver/import.ts
//
// hayba_sliver_import — accepts either an absolute file path or an
// https URL, fetches the JSON, validates against the sliver schema,
// installs into userDir. Returns the installed id or a clear reason on
// failure. No network sandbox; trust is social — the LLM's caller (or
// the user) is responsible for vetting URLs.

import { z } from 'zod';
import { readFileSync, existsSync, statSync } from 'node:fs';
import type { SliverLoader } from '../../slivers/loader.js';

export const sliverImportSchema = { source: z.string().min(1) };

export interface SliverImportCtx { loader: SliverLoader; }
export type SliverImportResult =
  | { ok: true; id: string; path: string; source: string }
  | { ok: false; reason: string };

export async function sliverImportHandler(
  args: { source: string },
  ctx: SliverImportCtx,
): Promise<SliverImportResult> {
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
  when: 'You want to install a sliver from a local file path or an http(s) URL into the user sliver library.',
  not_when: 'You only want to run an already-installed sliver — use hayba_sliver_run.',
  pack: 'core',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mcp-tools/hayba-mcp && npx vitest run src/tools/sliver/import.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/sliver/import.ts mcp-tools/hayba-mcp/src/tools/sliver/import.test.ts
git commit -m "feat(slivers): hayba_sliver_import MCP tool with file + URL support"
```

---

### Task 13: Wire sliver tools into routing/register.ts

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/register.ts`

- [ ] **Step 1: Add imports**

Open `mcp-tools/hayba-mcp/src/tools/routing/register.ts`. Find the import block ending around line 27 (the last `asset-retriever/meta-tools/reindex.js` import). After it, add:

```ts
import { setupSliverSystem, type SliverSystem } from '../../slivers/index.js';
import { sliverListHandler, sliverListSchema } from '../sliver/list.js';
import { sliverGetHandler,  sliverGetSchema  } from '../sliver/get.js';
import { sliverRunHandler,  sliverRunSchema  } from '../sliver/run.js';
import { sliverImportHandler, sliverImportSchema } from '../sliver/import.js';
```

- [ ] **Step 2: Add sliver ids to ALWAYS_ON_META**

Find the `ALWAYS_ON_META = new Set<string>([...])` block. Append these four ids inside the set, after `'hayba_asset_reindex'`:

```ts
  'hayba_sliver_list',
  'hayba_sliver_get',
  'hayba_sliver_run',
  'hayba_sliver_import',
```

- [ ] **Step 3: Extend RoutingHandle to expose the sliver system**

Find `export interface RoutingHandle { ... }`. Add one field:

```ts
  slivers: SliverSystem;
```

- [ ] **Step 4: Set up the sliver system + register the four tools**

Inside `registerDeferredRouting`, locate the asset-retriever block (`// ── Asset retriever (Layer 3a) ─────────────...`). Immediately *after* the closing of that block's last `server.tool(...)` (the `hayba_asset_reindex` registration) and *before* `// ── Always-load packs from settings ──────────`, add:

```ts
  // ── Slivers (Layer 2 — deterministic abstractions) ─────────────────────────
  const slivers = await setupSliverSystem();
  for (const err of slivers.loader.errors()) {
    console.warn(`[slivers] load error: ${err}`);
  }

  server.tool(
    'hayba_sliver_list',
    'List installed Slivers (deterministic abstractions). Optional category or namespace filter.',
    sliverListSchema,
    async (args: { category?: string; namespace?: string }) => {
      const r = await sliverListHandler(args, { loader: slivers.loader });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_sliver_get',
    'Get the full spec (params + determinism + executor) of an installed sliver by id.',
    sliverGetSchema,
    async (args: { id: string }) => {
      const r = await sliverGetHandler(args, { loader: slivers.loader });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_sliver_run',
    'Execute a sliver with concrete parameter values. Returns outputs + declared side_effects + durationMs.',
    sliverRunSchema,
    async (args: { id: string; params: Record<string, unknown> }) => {
      const r = await sliverRunHandler(args, { runtime: slivers.runtime });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_sliver_import',
    'Install a sliver from a local file path or an http(s) URL into the user sliver library.',
    sliverImportSchema,
    async (args: { source: string }) => {
      const r = await sliverImportHandler(args, { loader: slivers.loader });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );
```

- [ ] **Step 5: Return `slivers` in the RoutingHandle**

Find the `return { registry, index, retriever, ... };` at the bottom of `registerDeferredRouting`. Add `slivers,` to the returned object so it matches the extended interface.

- [ ] **Step 6: Typecheck**

Run: `cd mcp-tools/hayba-mcp && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Run full test suite**

Run: `cd mcp-tools/hayba-mcp && npm test`
Expected: all green (existing + new sliver tests).

- [ ] **Step 8: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/routing/register.ts
git commit -m "feat(slivers): wire 4 sliver tools into deferred routing + ALWAYS_ON_META"
```

---

### Task 14: build:assets copies bundled sliver specs to dist

**Files:**
- Modify: `mcp-tools/hayba-mcp/package.json`

- [ ] **Step 1: Update the build:assets script**

Open `mcp-tools/hayba-mcp/package.json`. Find the `"build:assets"` line. Replace its value with a script that copies *both* `packs.yaml` and every `*.sliver.json` under `src/slivers/specs/` to `dist/slivers/specs/`:

```json
    "build:assets": "node -e \"import('node:fs').then(fs=>{fs.mkdirSync('dist/tools/routing',{recursive:true});fs.copyFileSync('src/tools/routing/packs.yaml','dist/tools/routing/packs.yaml');fs.mkdirSync('dist/slivers/specs',{recursive:true});for(const f of fs.readdirSync('src/slivers/specs')){if(f.endsWith('.sliver.json'))fs.copyFileSync('src/slivers/specs/'+f,'dist/slivers/specs/'+f)}console.error('[build:assets] copied packs.yaml + sliver specs')})\"",
```

- [ ] **Step 2: Run the build**

Run: `cd mcp-tools/hayba-mcp && npm run build:server`
Expected: tsc succeeds; `[build:assets] copied packs.yaml + sliver specs` printed.

- [ ] **Step 3: Verify both artifacts exist**

Run: `cd mcp-tools/hayba-mcp && ls dist/slivers/specs/ && ls dist/tools/routing/packs.yaml`
Expected: `com.hayba.composition.frame_target.sliver.json` listed; `packs.yaml` path resolves.

- [ ] **Step 4: Commit**

```bash
git add mcp-tools/hayba-mcp/package.json
git commit -m "build(slivers): copy bundled sliver specs to dist on build"
```

---

### Task 15: Integration smoke test against compiled dist

**Files:**
- Create: `mcp-tools/hayba-mcp/.scratch/verify-slivers.mjs` (not committed; ephemeral verification)

- [ ] **Step 1: Write the smoke driver**

```js
// mcp-tools/hayba-mcp/.scratch/verify-slivers.mjs
// Drives the compiled sliver subsystem end-to-end without spinning up
// the full MCP server. Mirrors how registerDeferredRouting will use it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSliverSystem } from '../dist/slivers/index.js';

const userDir = mkdtempSync(join(tmpdir(), 'hayba-sliver-smoke-'));
try {
  const sys = await setupSliverSystem({ userDir });
  console.log('registered kinds:', sys.registry.kinds());
  console.log('installed slivers:', sys.loader.list().map(s => s.id));
  const r = await sys.runtime.runSliver('com.hayba.composition.frame_target', {
    target: '/Game/X.X', distance: 12, height: 1.5, fov: 60, yaw_deg: 30,
  });
  console.log('run result:', JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
} finally {
  rmSync(userDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run it**

Run: `cd mcp-tools/hayba-mcp && node .scratch/verify-slivers.mjs`
Expected:
- `registered kinds: [ 'composition.frame_target' ]`
- `installed slivers: [ 'com.hayba.composition.frame_target' ]`
- `run result` shows `"ok": true` and a `camera_transform` object.

- [ ] **Step 3: No commit (scratch artifact)**

`.scratch/` is gitignored per repo convention. Leave the file or delete it — it does not commit.

---

### Task 16: Open the PR

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feat/slivers-design-spec`
(or whichever branch this implementation lives on — if it's a fresh branch, create one with `git checkout -b feat/slivers-a-ts-runtime` first and push that.)

- [ ] **Step 2: Open the PR via gh**

```bash
gh pr create --title "Slivers v1 plan A: TS runtime + 4 MCP tools + frame_target" --body "$(cat <<'EOF'
## Summary
- Sliver runtime (types, zod schema, registry, runtime with cycle/depth guards, loader with bundled-seed)
- Four always-on MCP tools: hayba_sliver_{list,get,run,import}
- First bundled sliver: com.hayba.composition.frame_target (pure, returns camera_transform)
- build:assets now copies sliver specs to dist

Implements Plan A of the Slivers v1 spec
(docs/superpowers/specs/2026-05-21-slivers-design.md). No UE plugin
work in this PR — Plans B (UE Slivers UI) and C (time_of_day + lighting
handler) follow.

## Test plan
- [ ] npm test (mcp-tools/hayba-mcp) all green
- [ ] npm run build:server succeeds, dist/slivers/specs/ contains the bundled spec
- [ ] .scratch/verify-slivers.mjs prints ok=true with a sensible camera_transform
- [ ] Manual: in a running MCP client, hayba_sliver_list returns frame_target; hayba_sliver_run with valid params returns a transform
EOF
)"
```

Expected: PR URL printed.

---

## Self-Review Notes (post-write)

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| Identity (reverse-DNS regex) | Task 2 (`reverseDns` regex in schema) |
| Storage layout (%APPDATA%/Hayba/slivers/) | Task 6 (`defaultUserSliversDir`) |
| Param types (all 10) | Task 1 (TS) + Task 2 (Zod) + Task 4 (validator) |
| Determinism contract fields | Task 1 (types), Task 2 (schema), Task 5 (side_effect aggregation) |
| Composability + cycle detection + max depth | Task 5 (`runtime.test.ts` covers direct/indirect cycles + depth + sequential reuse) |
| MCP surface (4 tools) | Tasks 9–13 |
| ALWAYS_ON_META addition | Task 13 |
| Bundled spec shipping | Task 7 (json) + Task 14 (build copy) |
| URL import | Task 12 (https branch + fetch test) |
| Convention-only determinism | Implicit — no verifier in this plan, matches spec's v1 stance |

**Out of scope (correctly deferred):**
- UE Slivers tab UI → Plan B
- `time_of_day` + UE lighting handler → Plan C
- `sliver_draft` AI authoring tool → Phase 5
- Per-sliver `.preset.json` save/load → covered when UE UI ships (Plan B)
- `sliver_verify` determinism enforcement → v2

**Placeholder scan:** No TBDs, every code step contains the actual code, every test contains real assertions, every command has expected output.

**Type consistency check:** `SliverSpec.executor.kind` (string) flows through types.ts → spec-schema.ts → runtime.ts → registry.ts → composition/frame_target.ts (`COMPOSITION_FRAME_TARGET_KIND = 'composition.frame_target'`) consistently. `SliverRunResult` shape matches between runtime.ts, run.ts handler, and the smoke test assertion.
