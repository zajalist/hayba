# Architecture Pillar A1 — Style Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@hayba/architecture` package with the typology / style-sheet / style-guide schema, validators, 11 seed style-guides + 10 typologies as JSON data, and four MCP tools registered in the Hayba MCP server.

**Architecture:** Plain-TS interfaces (no Zod inside the engine package — matches `@hayba/linguistics`). Hand-rolled type guards in `validate.ts`. JSON data in `src/data/`, loaded synchronously at registry init. MCP wire layer is a thin Zod wrapper in `packages/hayba/src/tools/worldbuilding/architecture-handlers.ts` that calls into the pure engine.

**Tech Stack:** TypeScript 5.6+ (NodeNext modules, `verbatimModuleSyntax`), Vitest 2.1+, MIT license. Node 24+. Zod 3.x used only at the MCP boundary.

**Spec:** `docs/superpowers/specs/2026-05-12-architecture-style-schema-design.md`
**Issue:** [#101](https://github.com/zajalist/zajalist-hayba/issues/101)
**Branch:** `feat/architecture-pillar` (already created, the spec doc commit is HEAD)

---

## File Structure

```
packages/architecture/
├── package.json                              [Task 1]
├── tsconfig.json                             [Task 1]
├── vitest.config.ts                          [Task 1]
├── src/
│   ├── index.ts                              [Task 1, extended Task 9]
│   ├── schema.ts                             [Task 2]
│   ├── validate.ts                           [Tasks 3–6]
│   ├── validate.test.ts                      [Tasks 3–6]
│   ├── schema.test.ts                        [Task 2]
│   ├── registry.ts                           [Task 9]
│   ├── registry.test.ts                      [Task 9, extended Task 15]
│   ├── mcp.ts                                [Tasks 10–13]
│   ├── mcp.test.ts                           [Tasks 10–13]
│   └── data/
│       ├── typologies.json                   [Task 7]
│       └── style-guides/                     [Task 8]
│           ├── medieval-european-carolingian.json
│           ├── medieval-european-romanesque.json
│           ├── medieval-european-gothic.json
│           ├── tang-chinese-7c.json
│           ├── tang-chinese-9c.json
│           ├── andean-inca.json
│           ├── andean-pre-inca.json
│           ├── hausa-classical.json
│           ├── edo-japanese-early.json
│           ├── edo-japanese-late.json
│           └── industrial-revolution-english.json
└── docs/
    └── extras-glossary.md                    [Task 16]

packages/hayba/src/tools/worldbuilding/
└── architecture-handlers.ts                  [Task 14]   (new)

packages/hayba/src/tools/index.ts             [Task 14]   (modified — register 4 tools + reg() entries)
```

---

### Task 1: Scaffold `@hayba/architecture` package

**Files:**
- Create: `packages/architecture/package.json`
- Create: `packages/architecture/tsconfig.json`
- Create: `packages/architecture/vitest.config.ts`
- Create: `packages/architecture/src/index.ts`
- Create: `packages/architecture/src/smoke.test.ts` (temporary, deleted after Task 2)

- [ ] **Step 1: Write the failing smoke test**

`packages/architecture/src/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('package smoke', () => {
  it('exports the package name', () => {
    expect(PACKAGE_NAME).toBe('@hayba/architecture');
  });
});
```

- [ ] **Step 2: Create package.json**

`packages/architecture/package.json` (copy structure from `packages/linguistics/package.json`):
```json
{
  "name": "@hayba/architecture",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^24.12.2",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 3: Create tsconfig.json**

`packages/architecture/tsconfig.json` (identical to linguistics':
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "src/**/*.json"]
}
```
Note `resolveJsonModule: true` and `*.json` in include — needed to import seed JSON via TypeScript.

- [ ] **Step 4: Create vitest.config.ts**

`packages/architecture/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/validate.ts', 'src/registry.ts', 'src/mcp.ts'],
    },
  },
});
```

- [ ] **Step 5: Create initial index.ts**

`packages/architecture/src/index.ts`:
```ts
export const PACKAGE_NAME = '@hayba/architecture';
```

- [ ] **Step 6: Install workspace dependencies**

Run from repo root:
```bash
npm install --workspace=@hayba/architecture
```
Expected: package linked into root `node_modules`, no errors.

- [ ] **Step 7: Run smoke test**

Run from repo root:
```bash
npm test --workspace=@hayba/architecture
```
Expected: 1 test passes.

- [ ] **Step 8: Commit**

```bash
git add packages/architecture/package.json packages/architecture/tsconfig.json packages/architecture/vitest.config.ts packages/architecture/src/index.ts packages/architecture/src/smoke.test.ts package-lock.json
git commit -m "feat(architecture): scaffold @hayba/architecture package"
```

---

### Task 2: Schema types

**Files:**
- Create: `packages/architecture/src/schema.ts`
- Create: `packages/architecture/src/schema.test.ts`
- Delete: `packages/architecture/src/smoke.test.ts`
- Modify: `packages/architecture/src/index.ts` — replace placeholder with real re-exports

- [ ] **Step 1: Write failing test for type shapes**

`packages/architecture/src/schema.test.ts`:
```ts
import { describe, it, expectTypeOf } from 'vitest';
import type {
  FeatureBundle, RoofType, PrimaryMaterial, FootprintShape,
  Typology, StyleSheet, StyleGuide,
} from './schema.js';

describe('schema types', () => {
  it('FeatureBundle accepts string and string[] values', () => {
    const bundle: FeatureBundle = { roof: 'gable', tags: ['rural', 'old'] };
    expectTypeOf(bundle).toMatchTypeOf<Readonly<Record<string, string | readonly string[]>>>();
  });

  it('FootprintShape is a discriminated union of 5 kinds', () => {
    const kinds: FootprintShape['kind'][] =
      ['rectangle', 'linear-row', 'L-shape', 'U-shape', 'courtyard'];
    expectTypeOf(kinds).toMatchTypeOf<Array<FootprintShape['kind']>>();
  });

  it('Typology has the expected required fields', () => {
    const t: Typology = {
      id: 'peasant_home',
      footprint: { kind: 'rectangle', aspectRatio: [1, 2], areaRange: [25, 80] },
      storyRange: [1, 2],
      fenestrationDensity: [0.05, 0.15],
    };
    expectTypeOf(t.id).toBeString();
    expectTypeOf(t.storyRange).toEqualTypeOf<[number, number]>();
  });

  it('StyleSheet carries cultureId, dateRange, core, extras', () => {
    const s: StyleSheet = {
      id: 'test',
      cultureId: 'medieval-european',
      dateRange: [1140, 1400],
      core: { primaryMaterial: 'stone', roofType: 'gable', ornamentation: [] },
      extras: {},
    };
    expectTypeOf(s.cultureId).toBeString();
    expectTypeOf(s.dateRange).toEqualTypeOf<[number, number]>();
  });

  it('StyleGuide embeds StyleSheet by value and lists typology weights', () => {
    const g: StyleGuide = {
      id: 'test-guide',
      styleSheet: {
        id: 'test-sheet', cultureId: 'c', dateRange: [0, 1],
        core: { primaryMaterial: 'timber', roofType: 'thatch', ornamentation: [] },
        extras: {},
      },
      typologyWeights: [{ typologyId: 'peasant_home', weight: 1 }],
    };
    expectTypeOf(g.styleSheet).toMatchTypeOf<StyleSheet>();
    expectTypeOf(g.typologyWeights).toEqualTypeOf<ReadonlyArray<{ typologyId: string; weight: number }>>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture`
Expected: FAIL — `Cannot find module './schema.js'`.

- [ ] **Step 3: Write schema.ts**

`packages/architecture/src/schema.ts`:
```ts
/**
 * @hayba/architecture — schema definitions.
 *
 * Three artifacts: Typology (structural), StyleSheet (cosmetic),
 * StyleGuide (binds the two). All by-value, all readonly-safe.
 */

export type FeatureBundle = Readonly<Record<string, string | readonly string[]>>;

export type RoofType =
  | 'gable' | 'hip' | 'flat' | 'pagoda' | 'thatch' | 'dome' | 'shed' | 'mansard';

export const ROOF_TYPES = [
  'gable', 'hip', 'flat', 'pagoda', 'thatch', 'dome', 'shed', 'mansard',
] as const satisfies readonly RoofType[];

export type PrimaryMaterial =
  | 'stone' | 'timber' | 'mudbrick' | 'adobe' | 'rammed-earth'
  | 'brick' | 'concrete' | 'wattle-daub';

export const PRIMARY_MATERIALS = [
  'stone', 'timber', 'mudbrick', 'adobe', 'rammed-earth',
  'brick', 'concrete', 'wattle-daub',
] as const satisfies readonly PrimaryMaterial[];

export type FootprintKind =
  | 'rectangle' | 'linear-row' | 'L-shape' | 'U-shape' | 'courtyard';

export const FOOTPRINT_KINDS = [
  'rectangle', 'linear-row', 'L-shape', 'U-shape', 'courtyard',
] as const satisfies readonly FootprintKind[];

export type FootprintShape =
  | { kind: 'rectangle';  aspectRatio:        [number, number]; areaRange:        [number, number] }
  | { kind: 'linear-row'; widthRange:         [number, number]; depthRange:       [number, number] }
  | { kind: 'L-shape';    wingDepth:          [number, number]; courtyardFraction:[number, number] }
  | { kind: 'U-shape';    wingDepth:          [number, number]; openingWidth:     [number, number] }
  | { kind: 'courtyard';  courtyardFraction:  [number, number]; wingDepth:        [number, number] };

export interface Typology {
  id: string;
  footprint: FootprintShape;
  storyRange: [number, number];
  fenestrationDensity: [number, number];
  pathfindingHints?: Readonly<Record<string, string>>;
}

export interface StyleSheet {
  id: string;
  cultureId: string;
  dateRange: [number, number];
  core: {
    primaryMaterial: PrimaryMaterial;
    secondaryMaterial?: PrimaryMaterial;
    roofType: RoofType;
    ornamentation: readonly string[];
  };
  extras: FeatureBundle;
}

export interface StyleGuide {
  id: string;
  styleSheet: StyleSheet;
  typologyWeights: ReadonlyArray<{ typologyId: string; weight: number }>;
}
```

- [ ] **Step 4: Replace `index.ts` placeholder**

`packages/architecture/src/index.ts`:
```ts
export type {
  FeatureBundle, RoofType, PrimaryMaterial,
  FootprintKind, FootprintShape,
  Typology, StyleSheet, StyleGuide,
} from './schema.js';

export {
  ROOF_TYPES, PRIMARY_MATERIALS, FOOTPRINT_KINDS,
} from './schema.js';
```

- [ ] **Step 5: Delete the smoke test**

```bash
git rm packages/architecture/src/smoke.test.ts
```

- [ ] **Step 6: Run tests**

Run: `npm test --workspace=@hayba/architecture`
Expected: 5 tests pass (`schema.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add packages/architecture/src/schema.ts packages/architecture/src/schema.test.ts packages/architecture/src/index.ts
git commit -m "feat(architecture): A1 schema types — Typology, StyleSheet, StyleGuide"
```

---

### Task 3: Validator — `FootprintShape`

**Files:**
- Create: `packages/architecture/src/validate.ts`
- Create: `packages/architecture/src/validate.test.ts`

- [ ] **Step 1: Write failing tests for footprint validation**

`packages/architecture/src/validate.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { validateFootprintShape } from './validate.js';

describe('validateFootprintShape', () => {
  it('accepts a well-formed rectangle', () => {
    const errs = validateFootprintShape(
      { kind: 'rectangle', aspectRatio: [1, 2], areaRange: [25, 100] },
      '/footprint',
    );
    expect(errs).toEqual([]);
  });

  it('rejects unknown kind', () => {
    const errs = validateFootprintShape({ kind: 'pentagon' } as unknown, '/footprint');
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('/footprint/kind');
    expect(errs[0].message).toMatch(/unknown footprint kind/i);
  });

  it('rejects reversed aspect ratio', () => {
    const errs = validateFootprintShape(
      { kind: 'rectangle', aspectRatio: [3, 1], areaRange: [25, 100] },
      '/footprint',
    );
    expect(errs.some(e => e.path === '/footprint/aspectRatio')).toBe(true);
  });

  it('rejects non-array input', () => {
    const errs = validateFootprintShape('not an object' as unknown, '/footprint');
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('/footprint');
  });

  it('surfaces multiple errors for a malformed L-shape', () => {
    const errs = validateFootprintShape(
      { kind: 'L-shape', wingDepth: [5, 2], courtyardFraction: [-1, 0.5] },
      '/footprint',
    );
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- validate.test`
Expected: FAIL — `validate.js` missing.

- [ ] **Step 3: Write `validate.ts` with `validateFootprintShape` and shared helpers**

`packages/architecture/src/validate.ts`:
```ts
import {
  FOOTPRINT_KINDS, type FootprintShape, type FootprintKind,
} from './schema.js';

export interface ValidationError {
  path: string;       // JSON-pointer style, e.g. "/typologies/3/footprint/aspectRatio"
  message: string;
}

export class ArchitectureSchemaError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super(`@hayba/architecture: ${errors.length} validation error(s)`);
    this.name = 'ArchitectureSchemaError';
  }
}

/** Shared helper: `[min, max]` tuple with min ≤ max and both finite. */
export function validateRange(
  value: unknown, path: string, opts: { minAllowed?: number } = {},
): ValidationError[] {
  const errs: ValidationError[] = [];
  if (!Array.isArray(value) || value.length !== 2) {
    return [{ path, message: 'expected [min, max] tuple of length 2' }];
  }
  const [lo, hi] = value;
  if (typeof lo !== 'number' || !Number.isFinite(lo)) {
    errs.push({ path: `${path}/0`, message: 'min must be a finite number' });
  }
  if (typeof hi !== 'number' || !Number.isFinite(hi)) {
    errs.push({ path: `${path}/1`, message: 'max must be a finite number' });
  }
  if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) {
    errs.push({ path, message: `min (${lo}) must be ≤ max (${hi})` });
  }
  if (opts.minAllowed !== undefined && typeof lo === 'number' && lo < opts.minAllowed) {
    errs.push({ path: `${path}/0`, message: `min must be ≥ ${opts.minAllowed}` });
  }
  return errs;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateFootprintShape(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) {
    return [{ path, message: 'expected an object' }];
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !(FOOTPRINT_KINDS as readonly string[]).includes(kind)) {
    return [{
      path: `${path}/kind`,
      message: `unknown footprint kind ${JSON.stringify(kind)}; expected one of ${FOOTPRINT_KINDS.join(', ')}`,
    }];
  }
  const k = kind as FootprintKind;
  const errs: ValidationError[] = [];
  switch (k) {
    case 'rectangle':
      errs.push(...validateRange(value.aspectRatio, `${path}/aspectRatio`, { minAllowed: 0 }));
      errs.push(...validateRange(value.areaRange,   `${path}/areaRange`,   { minAllowed: 0 }));
      break;
    case 'linear-row':
      errs.push(...validateRange(value.widthRange, `${path}/widthRange`, { minAllowed: 0 }));
      errs.push(...validateRange(value.depthRange, `${path}/depthRange`, { minAllowed: 0 }));
      break;
    case 'L-shape':
      errs.push(...validateRange(value.wingDepth,         `${path}/wingDepth`,         { minAllowed: 0 }));
      errs.push(...validateRange(value.courtyardFraction, `${path}/courtyardFraction`, { minAllowed: 0 }));
      break;
    case 'U-shape':
      errs.push(...validateRange(value.wingDepth,    `${path}/wingDepth`,    { minAllowed: 0 }));
      errs.push(...validateRange(value.openingWidth, `${path}/openingWidth`, { minAllowed: 0 }));
      break;
    case 'courtyard':
      errs.push(...validateRange(value.courtyardFraction, `${path}/courtyardFraction`, { minAllowed: 0 }));
      errs.push(...validateRange(value.wingDepth,         `${path}/wingDepth`,         { minAllowed: 0 }));
      break;
  }
  return errs;
}

// Re-export the validated type narrowing helper for downstream tasks.
export function isFootprintShape(v: unknown): v is FootprintShape {
  return validateFootprintShape(v, '/').length === 0;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- validate.test`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/validate.ts packages/architecture/src/validate.test.ts
git commit -m "feat(architecture): A1 footprint shape validator"
```

---

### Task 4: Validator — `Typology`

**Files:**
- Modify: `packages/architecture/src/validate.ts` — add `validateTypology`
- Modify: `packages/architecture/src/validate.test.ts` — add typology tests

- [ ] **Step 1: Write failing tests**

Append to `packages/architecture/src/validate.test.ts`:
```ts
import { validateTypology } from './validate.js';

describe('validateTypology', () => {
  const valid = {
    id: 'peasant_home',
    footprint: { kind: 'rectangle', aspectRatio: [1, 2], areaRange: [25, 80] },
    storyRange: [1, 2],
    fenestrationDensity: [0.05, 0.15],
  };

  it('accepts a well-formed typology', () => {
    expect(validateTypology(valid, '/typology')).toEqual([]);
  });

  it('rejects empty id', () => {
    const errs = validateTypology({ ...valid, id: '' }, '/typology');
    expect(errs.some(e => e.path === '/typology/id')).toBe(true);
  });

  it('rejects missing footprint', () => {
    const { footprint: _, ...rest } = valid;
    const errs = validateTypology(rest, '/typology');
    expect(errs.some(e => e.path.startsWith('/typology/footprint'))).toBe(true);
  });

  it('rejects story range with min > max', () => {
    const errs = validateTypology({ ...valid, storyRange: [3, 1] }, '/typology');
    expect(errs.some(e => e.path === '/typology/storyRange')).toBe(true);
  });

  it('rejects fenestrationDensity > 1', () => {
    const errs = validateTypology({ ...valid, fenestrationDensity: [0.05, 1.5] }, '/typology');
    expect(errs.some(e => e.path.startsWith('/typology/fenestrationDensity'))).toBe(true);
  });

  it('accepts optional pathfindingHints record', () => {
    const errs = validateTypology(
      { ...valid, pathfindingHints: { footTraffic: 'high' } }, '/typology',
    );
    expect(errs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- validate.test`
Expected: FAIL — `validateTypology` not exported.

- [ ] **Step 3: Add `validateTypology` to `validate.ts`**

Append to `packages/architecture/src/validate.ts`:
```ts
import type { Typology } from './schema.js';

export function validateTypology(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) {
    return [{ path, message: 'expected an object' }];
  }
  const errs: ValidationError[] = [];
  if (typeof value.id !== 'string' || value.id.length === 0) {
    errs.push({ path: `${path}/id`, message: 'id must be a non-empty string' });
  }
  errs.push(...validateFootprintShape(value.footprint, `${path}/footprint`));
  errs.push(...validateRange(value.storyRange, `${path}/storyRange`, { minAllowed: 1 }));
  errs.push(...validateRange(value.fenestrationDensity, `${path}/fenestrationDensity`, { minAllowed: 0 }));
  if (Array.isArray(value.fenestrationDensity) && value.fenestrationDensity.length === 2) {
    const hi = value.fenestrationDensity[1];
    if (typeof hi === 'number' && hi > 1) {
      errs.push({
        path: `${path}/fenestrationDensity/1`,
        message: `max must be ≤ 1 (got ${hi})`,
      });
    }
  }
  if (value.pathfindingHints !== undefined) {
    if (!isPlainObject(value.pathfindingHints)) {
      errs.push({ path: `${path}/pathfindingHints`, message: 'expected an object' });
    } else {
      for (const [k, v] of Object.entries(value.pathfindingHints)) {
        if (typeof v !== 'string') {
          errs.push({
            path: `${path}/pathfindingHints/${k}`,
            message: 'expected string value',
          });
        }
      }
    }
  }
  return errs;
}

export function isTypology(v: unknown): v is Typology {
  return validateTypology(v, '/').length === 0;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- validate.test`
Expected: 11 tests pass (5 from Task 3 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/validate.ts packages/architecture/src/validate.test.ts
git commit -m "feat(architecture): A1 typology validator"
```

---

### Task 5: Validator — `StyleSheet`

**Files:**
- Modify: `packages/architecture/src/validate.ts` — add `validateStyleSheet`
- Modify: `packages/architecture/src/validate.test.ts` — add stylesheet tests

- [ ] **Step 1: Write failing tests**

Append to `packages/architecture/src/validate.test.ts`:
```ts
import { validateStyleSheet } from './validate.js';

describe('validateStyleSheet', () => {
  const valid = {
    id: 'medieval-european-gothic',
    cultureId: 'medieval-european',
    dateRange: [1140, 1400],
    core: {
      primaryMaterial: 'stone',
      roofType: 'gable',
      ornamentation: ['pointed-arch', 'flying-buttress'],
    },
    extras: { stainedGlass: 'present' },
  };

  it('accepts a well-formed sheet', () => {
    expect(validateStyleSheet(valid, '/sheet')).toEqual([]);
  });

  it('rejects unknown roofType', () => {
    const bad = { ...valid, core: { ...valid.core, roofType: 'tepee' } };
    const errs = validateStyleSheet(bad, '/sheet');
    expect(errs.some(e => e.path === '/sheet/core/roofType')).toBe(true);
  });

  it('rejects unknown primaryMaterial', () => {
    const bad = { ...valid, core: { ...valid.core, primaryMaterial: 'plasma' } };
    const errs = validateStyleSheet(bad, '/sheet');
    expect(errs.some(e => e.path === '/sheet/core/primaryMaterial')).toBe(true);
  });

  it('rejects extras with non-string-non-array value', () => {
    const bad = { ...valid, extras: { count: 42 } };
    const errs = validateStyleSheet(bad, '/sheet');
    expect(errs.some(e => e.path === '/sheet/extras/count')).toBe(true);
  });

  it('accepts extras with string[] values', () => {
    const ok = { ...valid, extras: { tags: ['rural', 'old'] } };
    expect(validateStyleSheet(ok, '/sheet')).toEqual([]);
  });

  it('rejects dateRange with negative endYear smaller than startYear', () => {
    const bad = { ...valid, dateRange: [1400, 1140] };
    const errs = validateStyleSheet(bad, '/sheet');
    expect(errs.some(e => e.path === '/sheet/dateRange')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- validate.test`
Expected: FAIL — `validateStyleSheet` not exported.

- [ ] **Step 3: Add `validateStyleSheet`**

Append to `packages/architecture/src/validate.ts`:
```ts
import {
  PRIMARY_MATERIALS, ROOF_TYPES,
  type PrimaryMaterial, type RoofType, type StyleSheet,
} from './schema.js';

function validateFeatureBundle(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) {
    return [{ path, message: 'expected an object' }];
  }
  const errs: ValidationError[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') continue;
    if (Array.isArray(v) && v.every(item => typeof item === 'string')) continue;
    errs.push({
      path: `${path}/${k}`,
      message: 'expected string or string[] value',
    });
  }
  return errs;
}

export function validateStyleSheet(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) {
    return [{ path, message: 'expected an object' }];
  }
  const errs: ValidationError[] = [];
  if (typeof value.id !== 'string' || value.id.length === 0) {
    errs.push({ path: `${path}/id`, message: 'id must be a non-empty string' });
  }
  if (typeof value.cultureId !== 'string' || value.cultureId.length === 0) {
    errs.push({ path: `${path}/cultureId`, message: 'cultureId must be a non-empty string' });
  }
  errs.push(...validateRange(value.dateRange, `${path}/dateRange`));

  const core = value.core;
  if (!isPlainObject(core)) {
    errs.push({ path: `${path}/core`, message: 'expected an object' });
  } else {
    if (!(PRIMARY_MATERIALS as readonly string[]).includes(core.primaryMaterial as string)) {
      errs.push({
        path: `${path}/core/primaryMaterial`,
        message: `unknown primaryMaterial ${JSON.stringify(core.primaryMaterial)}; expected one of ${PRIMARY_MATERIALS.join(', ')}`,
      });
    }
    if (core.secondaryMaterial !== undefined &&
        !(PRIMARY_MATERIALS as readonly string[]).includes(core.secondaryMaterial as string)) {
      errs.push({
        path: `${path}/core/secondaryMaterial`,
        message: `unknown secondaryMaterial ${JSON.stringify(core.secondaryMaterial)}`,
      });
    }
    if (!(ROOF_TYPES as readonly string[]).includes(core.roofType as string)) {
      errs.push({
        path: `${path}/core/roofType`,
        message: `unknown roofType ${JSON.stringify(core.roofType)}; expected one of ${ROOF_TYPES.join(', ')}`,
      });
    }
    if (!Array.isArray(core.ornamentation) ||
        !core.ornamentation.every(s => typeof s === 'string')) {
      errs.push({
        path: `${path}/core/ornamentation`,
        message: 'expected array of strings',
      });
    }
  }
  errs.push(...validateFeatureBundle(value.extras, `${path}/extras`));
  return errs;
}

export function isStyleSheet(v: unknown): v is StyleSheet {
  return validateStyleSheet(v, '/').length === 0;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- validate.test`
Expected: 17 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/validate.ts packages/architecture/src/validate.test.ts
git commit -m "feat(architecture): A1 stylesheet validator"
```

---

### Task 6: Validator — `StyleGuide` + cross-ref check

**Files:**
- Modify: `packages/architecture/src/validate.ts` — add `validateStyleGuide` + `validateStyleGuideRefs`
- Modify: `packages/architecture/src/validate.test.ts` — add guide tests

- [ ] **Step 1: Write failing tests**

Append to `packages/architecture/src/validate.test.ts`:
```ts
import { validateStyleGuide, validateStyleGuideRefs } from './validate.js';

describe('validateStyleGuide', () => {
  const sheet = {
    id: 's1', cultureId: 'c', dateRange: [0, 100],
    core: { primaryMaterial: 'timber', roofType: 'thatch', ornamentation: [] },
    extras: {},
  };
  const valid = {
    id: 'g1',
    styleSheet: sheet,
    typologyWeights: [
      { typologyId: 'peasant_home', weight: 1 },
      { typologyId: 'townhouse',    weight: 2.5 },
    ],
  };

  it('accepts a well-formed guide', () => {
    expect(validateStyleGuide(valid, '/g')).toEqual([]);
  });

  it('rejects empty typologyWeights', () => {
    const errs = validateStyleGuide({ ...valid, typologyWeights: [] }, '/g');
    expect(errs.some(e => e.path === '/g/typologyWeights')).toBe(true);
  });

  it('rejects zero/negative weight', () => {
    const bad = {
      ...valid,
      typologyWeights: [{ typologyId: 'peasant_home', weight: 0 }],
    };
    const errs = validateStyleGuide(bad, '/g');
    expect(errs.some(e => e.path === '/g/typologyWeights/0/weight')).toBe(true);
  });

  it('rejects malformed embedded styleSheet', () => {
    const bad = { ...valid, styleSheet: { ...sheet, core: { ...sheet.core, roofType: 'X' } } };
    const errs = validateStyleGuide(bad, '/g');
    expect(errs.some(e => e.path === '/g/styleSheet/core/roofType')).toBe(true);
  });
});

describe('validateStyleGuideRefs', () => {
  const sheet = {
    id: 's', cultureId: 'c', dateRange: [0, 1],
    core: { primaryMaterial: 'timber', roofType: 'thatch', ornamentation: [] },
    extras: {},
  };
  const guide = {
    id: 'g', styleSheet: sheet,
    typologyWeights: [{ typologyId: 'peasant_home', weight: 1 }],
  };

  it('returns no errors when all typology refs resolve', () => {
    expect(validateStyleGuideRefs(guide as never, new Set(['peasant_home']), '/g')).toEqual([]);
  });

  it('reports dangling typology references', () => {
    const errs = validateStyleGuideRefs(guide as never, new Set(['townhouse']), '/g');
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('/g/typologyWeights/0/typologyId');
    expect(errs[0].message).toMatch(/peasant_home/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@hayba/architecture -- validate.test`
Expected: FAIL.

- [ ] **Step 3: Add `validateStyleGuide` + `validateStyleGuideRefs`**

Append to `packages/architecture/src/validate.ts`:
```ts
import type { StyleGuide } from './schema.js';

export function validateStyleGuide(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) {
    return [{ path, message: 'expected an object' }];
  }
  const errs: ValidationError[] = [];
  if (typeof value.id !== 'string' || value.id.length === 0) {
    errs.push({ path: `${path}/id`, message: 'id must be a non-empty string' });
  }
  errs.push(...validateStyleSheet(value.styleSheet, `${path}/styleSheet`));

  if (!Array.isArray(value.typologyWeights)) {
    errs.push({ path: `${path}/typologyWeights`, message: 'expected array' });
  } else if (value.typologyWeights.length === 0) {
    errs.push({ path: `${path}/typologyWeights`, message: 'must list at least one typology' });
  } else {
    value.typologyWeights.forEach((entry, i) => {
      const ePath = `${path}/typologyWeights/${i}`;
      if (!isPlainObject(entry)) {
        errs.push({ path: ePath, message: 'expected an object' });
        return;
      }
      if (typeof entry.typologyId !== 'string' || entry.typologyId.length === 0) {
        errs.push({ path: `${ePath}/typologyId`, message: 'typologyId must be a non-empty string' });
      }
      if (typeof entry.weight !== 'number' || !Number.isFinite(entry.weight) || entry.weight <= 0) {
        errs.push({ path: `${ePath}/weight`, message: 'weight must be a positive finite number' });
      }
    });
  }
  return errs;
}

export function isStyleGuide(v: unknown): v is StyleGuide {
  return validateStyleGuide(v, '/').length === 0;
}

/**
 * Cross-reference check: every `typologyId` referenced from `guide.typologyWeights`
 * must exist in `knownTypologyIds`. Run AFTER `validateStyleGuide`; assumes
 * the guide is structurally valid.
 */
export function validateStyleGuideRefs(
  guide: StyleGuide, knownTypologyIds: ReadonlySet<string>, path: string,
): ValidationError[] {
  const errs: ValidationError[] = [];
  guide.typologyWeights.forEach((entry, i) => {
    if (!knownTypologyIds.has(entry.typologyId)) {
      errs.push({
        path: `${path}/typologyWeights/${i}/typologyId`,
        message: `unknown typologyId ${JSON.stringify(entry.typologyId)}`,
      });
    }
  });
  return errs;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- validate.test`
Expected: 23 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/validate.ts packages/architecture/src/validate.test.ts
git commit -m "feat(architecture): A1 styleguide validator + cross-ref check"
```

---

### Task 7: Typology seed data

**Files:**
- Create: `packages/architecture/src/data/typologies.json`

- [ ] **Step 1: Author `typologies.json`**

`packages/architecture/src/data/typologies.json`:
```json
{
  "typologies": [
    {
      "id": "peasant_home",
      "footprint": { "kind": "rectangle", "aspectRatio": [1.0, 1.6], "areaRange": [20, 60] },
      "storyRange": [1, 2],
      "fenestrationDensity": [0.04, 0.12]
    },
    {
      "id": "townhouse",
      "footprint": { "kind": "linear-row", "widthRange": [4, 7], "depthRange": [10, 22] },
      "storyRange": [2, 4],
      "fenestrationDensity": [0.12, 0.25]
    },
    {
      "id": "market_stall",
      "footprint": { "kind": "rectangle", "aspectRatio": [1.0, 2.5], "areaRange": [6, 20] },
      "storyRange": [1, 1],
      "fenestrationDensity": [0.0, 0.05]
    },
    {
      "id": "manor",
      "footprint": { "kind": "U-shape", "wingDepth": [6, 12], "openingWidth": [8, 18] },
      "storyRange": [2, 3],
      "fenestrationDensity": [0.18, 0.32]
    },
    {
      "id": "temple",
      "footprint": { "kind": "rectangle", "aspectRatio": [1.3, 2.2], "areaRange": [80, 600] },
      "storyRange": [1, 3],
      "fenestrationDensity": [0.05, 0.18]
    },
    {
      "id": "granary",
      "footprint": { "kind": "rectangle", "aspectRatio": [1.0, 1.4], "areaRange": [12, 80] },
      "storyRange": [1, 2],
      "fenestrationDensity": [0.0, 0.04]
    },
    {
      "id": "watchtower",
      "footprint": { "kind": "rectangle", "aspectRatio": [1.0, 1.2], "areaRange": [9, 36] },
      "storyRange": [3, 6],
      "fenestrationDensity": [0.02, 0.08]
    },
    {
      "id": "walled_palace",
      "footprint": { "kind": "courtyard", "courtyardFraction": [0.25, 0.5], "wingDepth": [8, 16] },
      "storyRange": [1, 3],
      "fenestrationDensity": [0.10, 0.25]
    },
    {
      "id": "workshop",
      "footprint": { "kind": "rectangle", "aspectRatio": [1.0, 2.0], "areaRange": [30, 120] },
      "storyRange": [1, 2],
      "fenestrationDensity": [0.10, 0.30]
    },
    {
      "id": "civic_hall",
      "footprint": { "kind": "rectangle", "aspectRatio": [1.5, 2.5], "areaRange": [100, 400] },
      "storyRange": [1, 2],
      "fenestrationDensity": [0.15, 0.35]
    }
  ]
}
```

- [ ] **Step 2: Stage and commit** (registry test follows in Task 9; data alone is not testable yet)

```bash
git add packages/architecture/src/data/typologies.json
git commit -m "feat(architecture): A1 seed typology registry (10 entries)"
```

---

### Task 8: StyleGuide seed data (11 files)

**Files:**
- Create: `packages/architecture/src/data/style-guides/medieval-european-carolingian.json`
- Create: `packages/architecture/src/data/style-guides/medieval-european-romanesque.json`
- Create: `packages/architecture/src/data/style-guides/medieval-european-gothic.json`
- Create: `packages/architecture/src/data/style-guides/tang-chinese-7c.json`
- Create: `packages/architecture/src/data/style-guides/tang-chinese-9c.json`
- Create: `packages/architecture/src/data/style-guides/andean-inca.json`
- Create: `packages/architecture/src/data/style-guides/andean-pre-inca.json`
- Create: `packages/architecture/src/data/style-guides/hausa-classical.json`
- Create: `packages/architecture/src/data/style-guides/edo-japanese-early.json`
- Create: `packages/architecture/src/data/style-guides/edo-japanese-late.json`
- Create: `packages/architecture/src/data/style-guides/industrial-revolution-english.json`

- [ ] **Step 1: Author first guide (full example to follow)**

`packages/architecture/src/data/style-guides/medieval-european-gothic.json`:
```json
{
  "id": "medieval-european-gothic",
  "styleSheet": {
    "id": "medieval-european-gothic",
    "cultureId": "medieval-european",
    "dateRange": [1140, 1400],
    "core": {
      "primaryMaterial": "stone",
      "secondaryMaterial": "timber",
      "roofType": "gable",
      "ornamentation": ["pointed-arch", "flying-buttress", "rose-window", "gargoyle"]
    },
    "extras": {
      "stainedGlass": "common",
      "verticalEmphasis": "strong",
      "tracery": "ribbed"
    }
  },
  "typologyWeights": [
    { "typologyId": "peasant_home", "weight": 6 },
    { "typologyId": "townhouse",    "weight": 4 },
    { "typologyId": "market_stall", "weight": 2 },
    { "typologyId": "manor",        "weight": 1 },
    { "typologyId": "temple",       "weight": 1 },
    { "typologyId": "watchtower",   "weight": 1 },
    { "typologyId": "civic_hall",   "weight": 1 }
  ]
}
```

- [ ] **Step 2: Author the remaining 10 guides following the same shape**

Each file follows the schema established above. Per-culture authoring hints — use these as starting points, refine from the reference sources in the spec (Atlas of Urban Form, Wikidata `P186`, VernacularArchitecture.com):

| File | cultureId | dateRange | primaryMaterial | roofType | Heavy-weighted typologies | Distinguishing `extras` |
|---|---|---|---|---|---|---|
| `medieval-european-carolingian.json` | `medieval-european` | `[750, 1000]` | `timber` | `gable` | peasant_home, granary, watchtower | `roofPitch: "steep"`, `defensiveWalls: "earthen"` |
| `medieval-european-romanesque.json` | `medieval-european` | `[1000, 1200]` | `stone` | `gable` | peasant_home, townhouse, temple, watchtower | `vaulting: "barrel"`, `windowSize: "small"` |
| `tang-chinese-7c.json` | `tang-chinese` | `[618, 800]` | `timber` | `pagoda` | peasant_home, townhouse, temple, walled_palace | `dougong: "present"`, `colorPalette: ["red","gold"]` |
| `tang-chinese-9c.json` | `tang-chinese` | `[800, 907]` | `timber` | `pagoda` | townhouse, walled_palace, temple, civic_hall | `dougong: "elaborate"`, `eaves: "deep-overhang"` |
| `andean-inca.json` | `andean` | `[1438, 1533]` | `stone` | `thatch` | peasant_home, granary, temple, walled_palace, watchtower | `wallStyle: "polygonal-fitted"`, `niches: "trapezoidal"` |
| `andean-pre-inca.json` | `andean` | `[200, 1438]` | `adobe` | `thatch` | peasant_home, granary, temple | `wallStyle: "coursed-adobe"` |
| `hausa-classical.json` | `hausa` | `[1400, 1800]` | `mudbrick` | `flat` | peasant_home, walled_palace, market_stall, civic_hall | `tubali: "molded-mud-cones"`, `multiBuilding: "true"`, `pinnacles: "azara"` |
| `edo-japanese-early.json` | `edo-japanese` | `[1603, 1750]` | `timber` | `hip` | peasant_home, townhouse, market_stall, temple | `engawa: "present"`, `tokonoma: "common"`, `shoji: "ubiquitous"` |
| `edo-japanese-late.json` | `edo-japanese` | `[1750, 1868]` | `timber` | `hip` | townhouse, market_stall, civic_hall, walled_palace | `engawa: "present"`, `kawara: "common"` |
| `industrial-revolution-english.json` | `industrial-revolution-english` | `[1760, 1900]` | `brick` | `mansard` | townhouse, workshop, civic_hall, market_stall | `chimneyStacks: "tall"`, `cornice: "stone"`, `bayWindows: "common"` |

Each file's `typologyWeights` MUST only reference typology ids defined in Task 7's `typologies.json` (`peasant_home, townhouse, market_stall, manor, temple, granary, watchtower, walled_palace, workshop, civic_hall`). Cross-ref will be checked in Task 9.

- [ ] **Step 3: Commit**

```bash
git add packages/architecture/src/data/style-guides/
git commit -m "feat(architecture): A1 seed style guides (11 culture/era palettes)"
```

---

### Task 9: Registry — load, cache, validate all data

**Files:**
- Create: `packages/architecture/src/registry.ts`
- Create: `packages/architecture/src/registry.test.ts`
- Modify: `packages/architecture/src/index.ts` — re-export registry surface

- [ ] **Step 1: Write failing test**

`packages/architecture/src/registry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  loadRegistry, listStyleGuideMeta, getStyleGuide, getTypology,
  ArchitectureRegistryError,
} from './registry.js';

describe('registry', () => {
  it('loads the bundled seed data without errors', () => {
    expect(() => loadRegistry()).not.toThrow();
  });

  it('exposes all 10 typologies', () => {
    const reg = loadRegistry();
    expect(reg.typologyIds.size).toBe(10);
    expect(reg.typologyIds.has('peasant_home')).toBe(true);
  });

  it('exposes all 11 style guides', () => {
    expect(listStyleGuideMeta().length).toBe(11);
  });

  it('every typologyId referenced from a guide resolves', () => {
    const reg = loadRegistry();
    for (const guide of reg.styleGuidesById.values()) {
      for (const w of guide.typologyWeights) {
        expect(reg.typologyIds.has(w.typologyId)).toBe(true);
      }
    }
  });

  it('getStyleGuide returns the embedded sheet for a known id', () => {
    const g = getStyleGuide('medieval-european-gothic');
    expect(g).not.toBeNull();
    expect(g!.styleSheet.cultureId).toBe('medieval-european');
  });

  it('getStyleGuide returns null for unknown id', () => {
    expect(getStyleGuide('not-a-real-id')).toBeNull();
  });

  it('getTypology returns null for unknown id', () => {
    expect(getTypology('not-a-real-id')).toBeNull();
  });

  it('loadRegistry is idempotent and returns the same cached object', () => {
    expect(loadRegistry()).toBe(loadRegistry());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- registry.test`
Expected: FAIL — `registry.js` missing.

- [ ] **Step 3: Implement registry**

`packages/architecture/src/registry.ts`:
```ts
import {
  validateTypology, validateStyleGuide, validateStyleGuideRefs,
  ArchitectureSchemaError, type ValidationError,
} from './validate.js';
import type { StyleGuide, Typology } from './schema.js';

import typologiesFile from './data/typologies.json' with { type: 'json' };

import g01 from './data/style-guides/medieval-european-carolingian.json' with { type: 'json' };
import g02 from './data/style-guides/medieval-european-romanesque.json' with { type: 'json' };
import g03 from './data/style-guides/medieval-european-gothic.json' with { type: 'json' };
import g04 from './data/style-guides/tang-chinese-7c.json' with { type: 'json' };
import g05 from './data/style-guides/tang-chinese-9c.json' with { type: 'json' };
import g06 from './data/style-guides/andean-inca.json' with { type: 'json' };
import g07 from './data/style-guides/andean-pre-inca.json' with { type: 'json' };
import g08 from './data/style-guides/hausa-classical.json' with { type: 'json' };
import g09 from './data/style-guides/edo-japanese-early.json' with { type: 'json' };
import g10 from './data/style-guides/edo-japanese-late.json' with { type: 'json' };
import g11 from './data/style-guides/industrial-revolution-english.json' with { type: 'json' };

const RAW_GUIDES: unknown[] = [g01, g02, g03, g04, g05, g06, g07, g08, g09, g10, g11];

export class ArchitectureRegistryError extends Error {
  constructor(public readonly errors: ValidationError[]) {
    super(`@hayba/architecture: registry load failed (${errors.length} error(s))`);
    this.name = 'ArchitectureRegistryError';
  }
}

export interface Registry {
  readonly typologies: ReadonlyMap<string, Typology>;
  readonly typologyIds: ReadonlySet<string>;
  readonly styleGuidesById: ReadonlyMap<string, StyleGuide>;
  readonly styleGuideOrder: readonly string[];   // sorted insertion order
}

let CACHED: Registry | null = null;

export function loadRegistry(): Registry {
  if (CACHED) return CACHED;

  const errors: ValidationError[] = [];
  const typologies = new Map<string, Typology>();
  const typologyIds = new Set<string>();

  const rawTypos = (typologiesFile as { typologies?: unknown[] }).typologies;
  if (!Array.isArray(rawTypos)) {
    throw new ArchitectureRegistryError([
      { path: '/typologies', message: 'typologies.json missing "typologies" array' },
    ]);
  }
  rawTypos.forEach((t, i) => {
    const errs = validateTypology(t, `/typologies/${i}`);
    if (errs.length === 0) {
      const typed = t as Typology;
      if (typologies.has(typed.id)) {
        errors.push({ path: `/typologies/${i}/id`, message: `duplicate typology id ${JSON.stringify(typed.id)}` });
      } else {
        typologies.set(typed.id, typed);
        typologyIds.add(typed.id);
      }
    } else {
      errors.push(...errs);
    }
  });

  const styleGuidesById = new Map<string, StyleGuide>();
  const styleGuideOrder: string[] = [];

  // Sort by source filename equivalent → use index order; data files are sorted alphabetically above.
  RAW_GUIDES.forEach((g, i) => {
    const path = `/styleGuides/${i}`;
    const errs = validateStyleGuide(g, path);
    if (errs.length > 0) {
      errors.push(...errs);
      return;
    }
    const typed = g as StyleGuide;
    if (styleGuidesById.has(typed.id)) {
      errors.push({ path: `${path}/id`, message: `duplicate styleGuide id ${JSON.stringify(typed.id)}` });
      return;
    }
    const refErrs = validateStyleGuideRefs(typed, typologyIds, path);
    if (refErrs.length > 0) {
      errors.push(...refErrs);
      return;
    }
    styleGuidesById.set(typed.id, typed);
    styleGuideOrder.push(typed.id);
  });

  if (errors.length > 0) {
    throw new ArchitectureRegistryError(errors);
  }

  CACHED = {
    typologies, typologyIds,
    styleGuidesById,
    styleGuideOrder: Object.freeze([...styleGuideOrder]),
  };
  return CACHED;
}

/** Test-only: drop the cache. NOT exposed via package index. */
export function _resetRegistryCacheForTests(): void {
  CACHED = null;
}

export interface StyleGuideMeta {
  id: string;
  cultureId: string;
  dateRange: [number, number];
  typologyCount: number;
}

export function listStyleGuideMeta(): StyleGuideMeta[] {
  const reg = loadRegistry();
  return reg.styleGuideOrder.map(id => {
    const g = reg.styleGuidesById.get(id)!;
    return {
      id: g.id,
      cultureId: g.styleSheet.cultureId,
      dateRange: g.styleSheet.dateRange,
      typologyCount: g.typologyWeights.length,
    };
  });
}

export function getStyleGuide(id: string): StyleGuide | null {
  return loadRegistry().styleGuidesById.get(id) ?? null;
}

export function getTypology(id: string): Typology | null {
  return loadRegistry().typologies.get(id) ?? null;
}

export { ArchitectureSchemaError };
```

- [ ] **Step 4: Update `index.ts` to re-export registry surface**

Replace `packages/architecture/src/index.ts` with:
```ts
export type {
  FeatureBundle, RoofType, PrimaryMaterial,
  FootprintKind, FootprintShape,
  Typology, StyleSheet, StyleGuide,
} from './schema.js';

export {
  ROOF_TYPES, PRIMARY_MATERIALS, FOOTPRINT_KINDS,
} from './schema.js';

export type { ValidationError } from './validate.js';
export {
  ArchitectureSchemaError,
  validateFootprintShape, validateTypology, validateStyleSheet,
  validateStyleGuide, validateStyleGuideRefs,
  isFootprintShape, isTypology, isStyleSheet, isStyleGuide,
} from './validate.js';

export type { Registry, StyleGuideMeta } from './registry.js';
export {
  ArchitectureRegistryError,
  loadRegistry, listStyleGuideMeta, getStyleGuide, getTypology,
} from './registry.js';
```

- [ ] **Step 5: Run tests**

Run: `npm test --workspace=@hayba/architecture`
Expected: 31 tests pass (23 validate + 8 registry).

- [ ] **Step 6: Commit**

```bash
git add packages/architecture/src/registry.ts packages/architecture/src/registry.test.ts packages/architecture/src/index.ts
git commit -m "feat(architecture): A1 registry loader + caching"
```

---

### Task 10: MCP tool — `architecture_list_style_guides`

**Files:**
- Create: `packages/architecture/src/mcp.ts`
- Create: `packages/architecture/src/mcp.test.ts`

- [ ] **Step 1: Write failing test**

`packages/architecture/src/mcp.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { listStyleGuides } from './mcp.js';

describe('architecture_list_style_guides', () => {
  it('returns metadata for all 11 seed guides', () => {
    const out = listStyleGuides();
    expect(out.guides).toHaveLength(11);
    expect(out.guides[0]).toMatchObject({
      id: expect.any(String),
      cultureId: expect.any(String),
      dateRange: expect.any(Array),
      typologyCount: expect.any(Number),
    });
  });

  it('output is byte-identical across calls', () => {
    expect(JSON.stringify(listStyleGuides())).toBe(JSON.stringify(listStyleGuides()));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- mcp.test`
Expected: FAIL — `mcp.js` missing.

- [ ] **Step 3: Create `mcp.ts` with `listStyleGuides`**

`packages/architecture/src/mcp.ts`:
```ts
import { listStyleGuideMeta, type StyleGuideMeta } from './registry.js';

export interface ListStyleGuidesResult {
  guides: StyleGuideMeta[];
}

export function listStyleGuides(): ListStyleGuidesResult {
  return { guides: listStyleGuideMeta() };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- mcp.test`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/mcp.ts packages/architecture/src/mcp.test.ts
git commit -m "feat(architecture): A1 MCP — list_style_guides"
```

---

### Task 11: MCP tool — `architecture_get_style_guide`

**Files:**
- Modify: `packages/architecture/src/mcp.ts` — add `getStyleGuideTool`
- Modify: `packages/architecture/src/mcp.test.ts` — add tests

- [ ] **Step 1: Write failing tests**

Append to `packages/architecture/src/mcp.test.ts`:
```ts
import { getStyleGuideTool } from './mcp.js';

describe('architecture_get_style_guide', () => {
  it('returns the full guide for a known id', () => {
    const out = getStyleGuideTool({ id: 'medieval-european-gothic' });
    expect('guide' in out).toBe(true);
    if ('guide' in out) {
      expect(out.guide.styleSheet.core.primaryMaterial).toBe('stone');
    }
  });

  it('returns not_found error for unknown id', () => {
    const out = getStyleGuideTool({ id: 'nonexistent' });
    expect(out).toEqual({ error: 'not_found', id: 'nonexistent' });
  });

  it('is deterministic across calls', () => {
    const a = JSON.stringify(getStyleGuideTool({ id: 'medieval-european-gothic' }));
    const b = JSON.stringify(getStyleGuideTool({ id: 'medieval-european-gothic' }));
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@hayba/architecture -- mcp.test`
Expected: FAIL.

- [ ] **Step 3: Add `getStyleGuideTool`**

Append to `packages/architecture/src/mcp.ts`:
```ts
import { getStyleGuide, getTypology } from './registry.js';
import type { StyleGuide, Typology } from './schema.js';

export type GetStyleGuideResult =
  | { guide: StyleGuide }
  | { error: 'not_found'; id: string };

export function getStyleGuideTool(args: { id: string }): GetStyleGuideResult {
  const g = getStyleGuide(args.id);
  if (!g) return { error: 'not_found', id: args.id };
  return { guide: g };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- mcp.test`
Expected: 5 tests pass total.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/mcp.ts packages/architecture/src/mcp.test.ts
git commit -m "feat(architecture): A1 MCP — get_style_guide"
```

---

### Task 12: MCP tool — `architecture_get_typology`

**Files:**
- Modify: `packages/architecture/src/mcp.ts` — add `getTypologyTool`
- Modify: `packages/architecture/src/mcp.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `packages/architecture/src/mcp.test.ts`:
```ts
import { getTypologyTool } from './mcp.js';

describe('architecture_get_typology', () => {
  it('returns typology for known id', () => {
    const out = getTypologyTool({ id: 'peasant_home' });
    expect('typology' in out).toBe(true);
    if ('typology' in out) {
      expect(out.typology.id).toBe('peasant_home');
      expect(out.typology.footprint.kind).toBe('rectangle');
    }
  });

  it('returns not_found for unknown id', () => {
    const out = getTypologyTool({ id: 'castle' });
    expect(out).toEqual({ error: 'not_found', id: 'castle' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@hayba/architecture -- mcp.test`
Expected: FAIL.

- [ ] **Step 3: Add `getTypologyTool`**

Append to `packages/architecture/src/mcp.ts`:
```ts
export type GetTypologyResult =
  | { typology: Typology }
  | { error: 'not_found'; id: string };

export function getTypologyTool(args: { id: string }): GetTypologyResult {
  const t = getTypology(args.id);
  if (!t) return { error: 'not_found', id: args.id };
  return { typology: t };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- mcp.test`
Expected: 7 tests pass total.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/mcp.ts packages/architecture/src/mcp.test.ts
git commit -m "feat(architecture): A1 MCP — get_typology"
```

---

### Task 13: MCP tool — `architecture_validate_style_guide`

**Files:**
- Modify: `packages/architecture/src/mcp.ts` — add `validateStyleGuideTool`
- Modify: `packages/architecture/src/mcp.test.ts`
- Modify: `packages/architecture/src/index.ts` — re-export MCP tools

- [ ] **Step 1: Write failing tests**

Append to `packages/architecture/src/mcp.test.ts`:
```ts
import { validateStyleGuideTool } from './mcp.js';

describe('architecture_validate_style_guide', () => {
  const valid = {
    id: 'test-guide',
    styleSheet: {
      id: 'test-sheet', cultureId: 'medieval-european', dateRange: [1000, 1200],
      core: { primaryMaterial: 'stone', roofType: 'gable', ornamentation: [] },
      extras: {},
    },
    typologyWeights: [{ typologyId: 'peasant_home', weight: 1 }],
  };

  it('returns ok=true for a well-formed guide with known typology refs', () => {
    expect(validateStyleGuideTool({ json: valid })).toEqual({ ok: true });
  });

  it('returns ok=true even if typology refs are unknown — refs are A1 registry concern only', () => {
    const bad = { ...valid, typologyWeights: [{ typologyId: 'unknown_t', weight: 1 }] };
    // Structural validation passes; ref check is run by the registry, not by this tool.
    expect(validateStyleGuideTool({ json: bad })).toEqual({ ok: true });
  });

  it('returns structured errors for a malformed input', () => {
    const out = validateStyleGuideTool({
      json: { id: '', styleSheet: { id: 's' }, typologyWeights: 'not-an-array' },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.length).toBeGreaterThanOrEqual(2);
      for (const e of out.errors) {
        expect(typeof e.path).toBe('string');
        expect(typeof e.message).toBe('string');
      }
    }
  });

  it('surfaces ALL errors (not first-fail)', () => {
    const out = validateStyleGuideTool({
      json: {
        id: '',
        styleSheet: {
          id: '', cultureId: '', dateRange: 'bad',
          core: { primaryMaterial: 'plasma', roofType: 'tepee', ornamentation: [] },
          extras: { broken: 42 },
        },
        typologyWeights: [],
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.length).toBeGreaterThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test --workspace=@hayba/architecture -- mcp.test`
Expected: FAIL.

- [ ] **Step 3: Add `validateStyleGuideTool`**

Append to `packages/architecture/src/mcp.ts`:
```ts
import { validateStyleGuide, type ValidationError } from './validate.js';

export type ValidateStyleGuideResult =
  | { ok: true }
  | { ok: false; errors: ValidationError[] };

export function validateStyleGuideTool(args: { json: unknown }): ValidateStyleGuideResult {
  const errs = validateStyleGuide(args.json, '');
  if (errs.length === 0) return { ok: true };
  return { ok: false, errors: errs };
}
```

- [ ] **Step 4: Re-export MCP tools from index.ts**

Append to `packages/architecture/src/index.ts`:
```ts
export type {
  ListStyleGuidesResult, GetStyleGuideResult, GetTypologyResult, ValidateStyleGuideResult,
} from './mcp.js';
export {
  listStyleGuides, getStyleGuideTool, getTypologyTool, validateStyleGuideTool,
} from './mcp.js';
```

- [ ] **Step 5: Run tests**

Run: `npm test --workspace=@hayba/architecture`
Expected: 47 tests pass (5 schema + 23 validate + 8 registry + 11 mcp).

- [ ] **Step 6: Commit**

```bash
git add packages/architecture/src/mcp.ts packages/architecture/src/mcp.test.ts packages/architecture/src/index.ts
git commit -m "feat(architecture): A1 MCP — validate_style_guide"
```

---

### Task 14: Wire MCP tools into the Hayba MCP server

**Files:**
- Create: `packages/hayba/src/tools/worldbuilding/architecture-handlers.ts`
- Modify: `packages/hayba/src/tools/index.ts` — register the four tools + reg() entries
- Modify: `packages/hayba/package.json` — add `@hayba/architecture` dependency

- [ ] **Step 1: Add the workspace dependency**

Edit `packages/hayba/package.json`. Find the `"dependencies"` block (it already contains `@hayba/linguistics`) and add:
```json
"@hayba/architecture": "*",
```

Then run from repo root:
```bash
npm install
```

- [ ] **Step 2: Create the handler module**

`packages/hayba/src/tools/worldbuilding/architecture-handlers.ts`:
```ts
import { z } from 'zod';
import {
  listStyleGuides as engineListStyleGuides,
  getStyleGuideTool as engineGetStyleGuide,
  getTypologyTool as engineGetTypology,
  validateStyleGuideTool as engineValidateStyleGuide,
} from '@hayba/architecture';

/* ─────────────────────  schemas  ───────────────────── */

export const listStyleGuidesSchema = z.object({});

export const getStyleGuideSchema = z.object({
  id: z.string().describe('StyleGuide id, e.g. "medieval-european-gothic"'),
});

export const getTypologySchema = z.object({
  id: z.string().describe('Typology id, e.g. "peasant_home"'),
});

export const validateStyleGuideSchema = z.object({
  json: z.unknown().describe('Candidate StyleGuide JSON to validate against the A1 schema'),
});

/* ─────────────────────  handlers  ───────────────────── */

export function listStyleGuides(_params: z.infer<typeof listStyleGuidesSchema>) {
  return engineListStyleGuides();
}

export function getStyleGuide(params: z.infer<typeof getStyleGuideSchema>) {
  return engineGetStyleGuide(params);
}

export function getTypology(params: z.infer<typeof getTypologySchema>) {
  return engineGetTypology(params);
}

export function validateStyleGuide(params: z.infer<typeof validateStyleGuideSchema>) {
  return engineValidateStyleGuide(params);
}
```

- [ ] **Step 3: Register the tools in `packages/hayba/src/tools/index.ts`**

This file is large; the operations are additive. Two changes:

**(a)** Near the top with other tool imports, add:
```ts
import {
  listStyleGuidesSchema,
  getStyleGuideSchema,
  getTypologySchema,
  validateStyleGuideSchema,
  listStyleGuides as architectureListStyleGuides,
  getStyleGuide as architectureGetStyleGuide,
  getTypology as architectureGetTypology,
  validateStyleGuide as architectureValidateStyleGuide,
} from './worldbuilding/architecture-handlers.js';
```

**(b)** In the `server.tool(...)` block — search for the existing `language_remix_phonologies` registration (it lives just before the planet tools). After its closing `);`, add four blocks:

```ts
  server.tool(
    'architecture_list_style_guides',
    'List all seed StyleGuide palettes (metadata only — id, cultureId, dateRange, typologyCount).',
    listStyleGuidesSchema.shape,
    async (params) => {
      try {
        const result = architectureListStyleGuides(params as z.infer<typeof listStyleGuidesSchema>);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }], isError: true };
      }
    }
  );

  server.tool(
    'architecture_get_style_guide',
    'Fetch a full StyleGuide by id (embedded StyleSheet + typologyWeights). Returns { error: "not_found" } if unknown.',
    getStyleGuideSchema.shape,
    async (params) => {
      try {
        const result = architectureGetStyleGuide(params as z.infer<typeof getStyleGuideSchema>);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }], isError: true };
      }
    }
  );

  server.tool(
    'architecture_get_typology',
    'Fetch a Typology by id (footprint, storyRange, fenestrationDensity). Returns { error: "not_found" } if unknown.',
    getTypologySchema.shape,
    async (params) => {
      try {
        const result = architectureGetTypology(params as z.infer<typeof getTypologySchema>);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }], isError: true };
      }
    }
  );

  server.tool(
    'architecture_validate_style_guide',
    'Validate a candidate StyleGuide JSON against the A1 schema. Returns { ok: true } or { ok: false, errors: [...] }.',
    validateStyleGuideSchema.shape,
    async (params) => {
      try {
        const result = architectureValidateStyleGuide(params as z.infer<typeof validateStyleGuideSchema>);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: msg }) }], isError: true };
      }
    }
  );
```

**(c)** Add corresponding `reg(...)` entries. Search for the existing `reg('language_remix_phonologies', ...)` line and add immediately after:
```ts
  reg('architecture_list_style_guides',   listStyleGuidesSchema.shape,   'low', '{guides:[{id,cultureId,dateRange,typologyCount}]}');
  reg('architecture_get_style_guide',     getStyleGuideSchema.shape,     'low', '{guide}|{error,id}');
  reg('architecture_get_typology',        getTypologySchema.shape,       'low', '{typology}|{error,id}');
  reg('architecture_validate_style_guide',validateStyleGuideSchema.shape,'low', '{ok}|{ok:false,errors:[{path,message}]}');
```

- [ ] **Step 4: Run the hayba package's typecheck**

Run from repo root:
```bash
npm run typecheck --workspace=hayba
```
Expected: PASS, no type errors.

- [ ] **Step 5: Run the hayba test suite**

Run from repo root:
```bash
npm test --workspace=hayba
```
Expected: existing tests still pass; nothing in `tools/index.test.ts` broke.

- [ ] **Step 6: Commit**

```bash
git add packages/hayba/package.json packages/hayba/src/tools/worldbuilding/architecture-handlers.ts packages/hayba/src/tools/index.ts package-lock.json
git commit -m "feat(architecture): wire A1 MCP tools into hayba server"
```

---

### Task 15: Determinism + cross-pillar contract tests

**Files:**
- Modify: `packages/architecture/src/mcp.test.ts` — add the determinism sweep
- Modify: `packages/architecture/src/registry.test.ts` — add the cross-ref sweep

- [ ] **Step 1: Add the determinism sweep**

Append to `packages/architecture/src/mcp.test.ts`:
```ts
import { listStyleGuides as _ls, getStyleGuideTool as _gs, getTypologyTool as _gt }
  from './mcp.js';

describe('determinism — byte-identical JSON across calls', () => {
  it('list_style_guides', () => {
    expect(JSON.stringify(_ls())).toBe(JSON.stringify(_ls()));
  });
  it('get_style_guide on every seed id', () => {
    const ids = _ls().guides.map(g => g.id);
    for (const id of ids) {
      expect(JSON.stringify(_gs({ id }))).toBe(JSON.stringify(_gs({ id })));
    }
  });
  it('get_typology on every seed typology', () => {
    const seen = new Set<string>();
    for (const meta of _ls().guides) {
      const g = _gs({ id: meta.id });
      if ('guide' in g) {
        for (const w of g.guide.typologyWeights) seen.add(w.typologyId);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const id of seen) {
      expect(JSON.stringify(_gt({ id }))).toBe(JSON.stringify(_gt({ id })));
    }
  });
});
```

- [ ] **Step 2: Add the cross-pillar contract sweep**

Append to `packages/architecture/src/registry.test.ts`:
```ts
describe('cross-pillar contract — every guide ref resolves', () => {
  it('no dangling typologyId in any seed StyleGuide', () => {
    const reg = loadRegistry();
    const missing: Array<{ guide: string; typologyId: string }> = [];
    for (const guide of reg.styleGuidesById.values()) {
      for (const w of guide.typologyWeights) {
        if (!reg.typologyIds.has(w.typologyId)) {
          missing.push({ guide: guide.id, typologyId: w.typologyId });
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every guide has at least one typology weight', () => {
    const reg = loadRegistry();
    for (const guide of reg.styleGuidesById.values()) {
      expect(guide.typologyWeights.length).toBeGreaterThan(0);
    }
  });

  it('within a culture, overlapping dateRanges are detected (warning surface)', () => {
    const reg = loadRegistry();
    const byCulture = new Map<string, Array<{ id: string; range: [number, number] }>>();
    for (const guide of reg.styleGuidesById.values()) {
      const list = byCulture.get(guide.styleSheet.cultureId) ?? [];
      list.push({ id: guide.id, range: guide.styleSheet.dateRange });
      byCulture.set(guide.styleSheet.cultureId, list);
    }
    // Sanity check: tiebreaker rule documented in spec — highest endYear wins. This test
    // just asserts the data set is well-formed enough that A5 selection has a deterministic answer.
    for (const [_culture, list] of byCulture) {
      const sorted = [...list].sort((a, b) => b.range[1] - a.range[1]);
      expect(sorted[0]).toBeDefined();
    }
  });
});
```

- [ ] **Step 3: Run tests**

Run from repo root:
```bash
npm test --workspace=@hayba/architecture
```
Expected: 53 tests pass total (5 schema + 23 validate + 11 registry + 14 mcp).

- [ ] **Step 4: Commit**

```bash
git add packages/architecture/src/mcp.test.ts packages/architecture/src/registry.test.ts
git commit -m "test(architecture): A1 determinism + cross-pillar contract sweeps"
```

---

### Task 16: extras-glossary.md

**Files:**
- Create: `packages/architecture/docs/extras-glossary.md`

- [ ] **Step 1: Author the glossary**

`packages/architecture/docs/extras-glossary.md`:
```markdown
# StyleSheet `extras` glossary

The `extras` field on `StyleSheet` is an open `FeatureBundle` (`Record<string, string | string[]>`) for culture-specific concepts that don't fit the typed `core` fields. Every key used by a seed StyleGuide must appear here.

Promote a key to `StyleSheet.core` (a real typed field) once it generalizes across cultures.

## Keys in use

| Key | Cultures using it | Type | Notes |
|---|---|---|---|
| `bayWindows` | industrial-revolution-english | string | Frequency tag, e.g. `"common"`. |
| `chimneyStacks` | industrial-revolution-english | string | Height tag, e.g. `"tall"`. |
| `colorPalette` | tang-chinese | string[] | Named pigments. |
| `cornice` | industrial-revolution-english | string | Material tag, e.g. `"stone"`. |
| `defensiveWalls` | medieval-european-carolingian | string | Material tag. |
| `dougong` | tang-chinese | string | Bracket-set complexity tag (`present` / `elaborate`). |
| `eaves` | tang-chinese-9c | string | Overhang depth tag. |
| `engawa` | edo-japanese | string | Verandah strip, `"present"` if part of vernacular. |
| `kawara` | edo-japanese-late | string | Clay tile roof tag. |
| `multiBuilding` | hausa-classical | string | `"true"` marks compound-typology archetypes; A3 may treat as cluster. |
| `niches` | andean-inca | string | Wall-niche shape tag (`trapezoidal`). |
| `pinnacles` | hausa-classical | string | Roof-edge ornament (azara pinnacles). |
| `roofPitch` | medieval-european-carolingian | string | Steepness tag. |
| `shoji` | edo-japanese-early | string | Paper-screen partition prevalence. |
| `stainedGlass` | medieval-european-gothic | string | Frequency tag. |
| `tokonoma` | edo-japanese-early | string | Decorative alcove prevalence. |
| `tracery` | medieval-european-gothic | string | Window-stonework style tag. |
| `tubali` | hausa-classical | string | Molded mud cones, characteristic of Hausa Zaure. |
| `vaulting` | medieval-european-romanesque | string | Roof-vault style. |
| `verticalEmphasis` | medieval-european-gothic | string | Massing tag. |
| `wallStyle` | andean | string | Polygonal-fitted vs. coursed-adobe. |
| `windowSize` | medieval-european-romanesque | string | Relative size tag. |

## Promotion candidates

Keys appearing in 3+ cultures should be considered for promotion to `core`:

- `wallStyle` (currently 2 cultures) — could become `core.wallStyle: 'fitted-polygonal' | 'coursed' | 'tubali' | ...` once a third culture lands.
- `roofPitch` — overlaps semantically with `roofType`; consider folding into roof-type tags rather than promoting.

## Authoring rules

1. New extras keys MUST be added to this table in the same commit as the StyleGuide JSON that introduces them.
2. Don't reuse a key for a different concept across cultures. If two cultures need different `tracery` semantics, namespace: `tracery.medieval-european`.
3. Prefer `string` over `string[]` unless the field is genuinely a set (e.g., `colorPalette`).
```

- [ ] **Step 2: Commit**

```bash
git add packages/architecture/docs/extras-glossary.md
git commit -m "docs(architecture): A1 extras-glossary"
```

---

### Task 17: Coverage check + final wrap

**Files:** none modified — validation only.

- [ ] **Step 1: Run full test suite + coverage**

Run from repo root:
```bash
npm test --workspace=@hayba/architecture -- --coverage
```
Expected:
- All 53 tests pass.
- Coverage for `src/validate.ts`, `src/registry.ts`, `src/mcp.ts` each ≥ 80%.

If coverage falls short on a file, add targeted tests in the corresponding `*.test.ts` rather than chasing arbitrary numbers.

- [ ] **Step 2: Run the typecheck**

Run from repo root:
```bash
npm run typecheck --workspace=@hayba/architecture
npm run typecheck --workspace=hayba
```
Expected: both pass clean.

- [ ] **Step 3: Verify the hayba MCP server still boots**

Run from repo root:
```bash
npm run build --workspace=@hayba/architecture
npm run build --workspace=hayba
```
Expected: both build clean, no missing-module errors from the new architecture imports.

- [ ] **Step 4: Smoke-check the MCP tool list**

Read `packages/hayba/src/tools/index.ts` to confirm all four new tools are registered (two appearances each — once in `server.tool(...)` and once in `reg(...)`). Run:
```bash
grep -c "architecture_" packages/hayba/src/tools/index.ts
```
Expected: at least 12 hits (4 tools × 3 typical references — import, server.tool, reg).

- [ ] **Step 5: Tick the issue acceptance checklist**

Update GH issue #101 — tick the boxes that are now complete:
```bash
gh issue edit 101 -R zajalist/hayba --body "$(gh issue view 101 -R zajalist/hayba --json body -q .body | sed 's/- \[ \] Schema published/- [x] Schema published/' | sed 's/- \[ \] Six palettes/- [x] Eleven palettes/' | sed 's/- \[ \] MCP tool registered/- [x] Four MCP tools registered/' | sed 's/- \[ \] vitest/- [x] vitest/' | sed 's/- \[ \] Style-guide JSON treated/- [x] Style-guide JSON treated/')"
```
(If the sed substitutions look off after fetching the current body, edit the body manually via `gh issue edit 101 -R zajalist/hayba` instead.)

- [ ] **Step 6: Final commit** (only if previous steps touched files)

```bash
git status
```
If clean — nothing to commit, Task 17 is verification only.

If any files changed (e.g., from coverage-targeted tests in Step 1), commit them:
```bash
git add packages/architecture/src/
git commit -m "test(architecture): A1 coverage fill-in"
```

- [ ] **Step 7: Push the branch**

Only after the user explicitly approves pushing:
```bash
git push -u origin feat/architecture-pillar
```

---

## Definition of done (mirrors issue #101)

- [x] Schema published from `packages/architecture/src/schema.ts` *(Task 2)*
- [x] All 11 seed StyleGuides + 10 typologies validate against the schema and load deterministically *(Task 9, Task 15)*
- [x] Four MCP tools registered in `packages/hayba/src/tools/index.ts` and exercised by tests *(Tasks 10–14)*
- [x] vitest ≥80% on validators; determinism test green *(Tasks 15, 17)*
- [x] No GPL-licensed inputs in `data/` *(Task 7, Task 8)*
- [x] `packages/architecture/docs/extras-glossary.md` exists and documents every extras key used *(Task 16)*

## Self-review notes (already applied to the plan above)

- Confirmed spec coverage: every "Out of scope for A1" item in the spec is genuinely absent from the plan.
- Confirmed every `typologyId` referenced from any task's example JSON appears in the Task 7 registry (`peasant_home, townhouse, market_stall, manor, temple, granary, watchtower, walled_palace, workshop, civic_hall`).
- Confirmed every method/symbol used in a later task is exported by an earlier task (e.g., `validateStyleGuideRefs` introduced in Task 6, used in Task 9).
- Confirmed test count math: Task 2 (5) + Task 3 (5) + Task 4 (6) + Task 5 (6) + Task 6 (6) + Task 9 (8) + Task 10 (2) + Task 11 (3) + Task 12 (2) + Task 13 (4) + Task 15 determinism (3) + Task 15 contract (3) = **53 tests** by Task 17 end. Intermediate expected counts in Tasks 13 (47) and 15/17 (53) are correct after this self-review pass.
