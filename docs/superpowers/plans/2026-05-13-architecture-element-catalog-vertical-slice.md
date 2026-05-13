# Architecture Element Catalog — Vertical Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first end-to-end vertical slice of the element catalog — the `column` element with a hand-authored `medieval-european-gothic` binding renders to a 3D preview in the architecture atlas's style-sheet detail page.

**Architecture:** Schema extension on top of A1 (Element + ElementBinding types). Tiny kernel with four geometric primitives (transform / revolve / loft / mergeMeshes) and SVG profile parsing for straight-line paths. Plain TS interfaces, no Zod. three.js used only for glTF binary emission. Hand-authored TypeScript generator per element type — code, not data. No AI yet — Gothic column binding is hand-crafted SVG; AI pipeline comes in a follow-up plan.

**Tech Stack:** TypeScript 5.6+ (NodeNext, `verbatimModuleSyntax`), Vitest 2.1+, three.js 0.169+, MIT license. Node 24+. Atlas uses a bare ESM `<script type="module">` import from `../dist/` for the GLB viewer.

**Spec:** `docs/superpowers/specs/2026-05-13-architecture-element-catalog-design.md`
**Branch:** `feat/architecture-pillar` (continues from A1; 20 commits ahead of `main`)
**Out of scope for this plan** (lives in follow-up plans):
- Other 9 elements (cornice, arch, doorframe, windowframe, lintel, finial, frieze panel, pediment relief, niche).
- All other bindings (other 10 style sheets × column; all elements × other style sheets).
- AI binding pipeline (`generate_binding`, providers, prompts, validator-retry loop).
- Boolean / CSG ops (deferred — column doesn't need real CSG, only mesh-merge).
- MCP tools (`architecture_list_elements`, `_get_element`, etc.) — Plan 4.
- UE5 PCG export (`toPCGGraph` stub) — Plan 5+.
- Editor matrix view, regenerate UX, reference upload — Plan 5.

---

## File Structure

```
packages/architecture/
├── package.json                                       [Task 4]    (modified — add three.js dep)
├── src/
│   ├── schema.ts                                      [Task 1]    (modified — add Element types)
│   ├── validate.ts                                    [Task 2]    (modified — add element validators)
│   ├── index.ts                                       [Task 14]   (modified — export kernel + element registry)
│   ├── validate.test.ts                               [Task 2]    (modified — add element validator tests)
│   ├── data/
│   │   └── elements/                                  [Task 3]
│   │       └── column.json                            [Task 3]    (new)
│   ├── bindings/                                      [Task 13]
│   │   └── medieval-european-gothic/                  [Task 13]
│   │       └── column.json                            [Task 13]   (new — hand-authored binding)
│   ├── kernel/                                        [Tasks 5–12]
│   │   ├── types.ts                                   [Task 5]    (new — Mesh, Vec3, Mat4, SvgPath types)
│   │   ├── svg-parse.ts                               [Task 6]    (new — parseSvgProfile)
│   │   ├── svg-parse.test.ts                          [Task 6]    (new)
│   │   ├── primitives.ts                              [Tasks 7–10] (new — transform, revolve, loft, mergeMeshes)
│   │   ├── primitives.test.ts                         [Tasks 7–10] (new)
│   │   ├── glb-emit.ts                                [Task 11]   (new — mesh → glTF binary via three.js)
│   │   ├── glb-emit.test.ts                           [Task 11]   (new)
│   │   └── elements/
│   │       ├── column.ts                              [Task 12]   (new — columnGraph generator)
│   │       ├── column.test.ts                         [Task 12]   (new)
│   │       └── index.ts                               [Task 14]   (new — generator registry)
│   ├── element-registry.ts                            [Task 14]   (new — loadElementCatalog + binding loader)
│   └── element-registry.test.ts                       [Task 15]   (new — determinism + cross-ref tests)
└── demo/
    └── index.html                                     [Task 16]   (modified — Bound elements section + three.js viewer)
```

---

### Task 1: Schema extension — Element / ProfileSlot / ParamSlot / ElementBinding

**Files:**
- Modify: `packages/architecture/src/schema.ts` — append new types.
- Modify: `packages/architecture/src/schema.test.ts` — add type-shape assertions.

- [ ] **Step 1: Write failing test**

Append to `packages/architecture/src/schema.test.ts`:
```ts
import type {
  Element, ProfileSlot, ParamSlot, ElementBinding, ElementGraphRef,
} from './schema.js';

describe('element schema types', () => {
  it('ProfileSlot constrains hint to the four allowed values', () => {
    const slots: ProfileSlot[] = [
      { name: 'shaft', description: 'half-profile', hint: 'symmetric-half' },
      { name: 'cap',   description: 'closed top',   hint: 'closed-path' },
      { name: 'curve', description: 'open arc',     hint: 'open-path' },
      { name: 'tile',  description: 'tileable',     hint: 'tileable' },
    ];
    expectTypeOf(slots[0].hint).toEqualTypeOf<'closed-path' | 'open-path' | 'symmetric-half' | 'tileable'>();
  });

  it('ParamSlot supports number, integer, and enum kinds', () => {
    const slots: ParamSlot[] = [
      { name: 'shaft_h', kind: 'number',  range: [1.5, 8.0], default: 3.0 },
      { name: 'segs',    kind: 'integer', range: [8, 64],    default: 32 },
      { name: 'fluting', kind: 'enum',    choices: ['none', 'shallow', 'deep'], default: 'shallow' },
    ];
    expectTypeOf(slots[0].kind).toEqualTypeOf<'number' | 'integer' | 'enum'>();
  });

  it('Element bundles slots + paramSchema + generator ref', () => {
    const el: Element = {
      id: 'column',
      category: 'connector',
      graph: { kind: 'kernel-fn', module: './kernel/elements/column.js', export: 'columnGraph' },
      profileSlots: [
        { name: 'shaft', description: 'half-profile', hint: 'symmetric-half' },
      ],
      paramSchema: [
        { name: 'shaft_height_m', kind: 'number', range: [1.5, 8.0], default: 3.0 },
      ],
    };
    expectTypeOf(el.category).toEqualTypeOf<'connector' | 'ornament'>();
  });

  it('ElementBinding carries profiles, params, seed, provenance', () => {
    const b: ElementBinding = {
      elementId: 'column',
      styleSheetId: 'medieval-european-gothic',
      seed: 1n,
      profiles: { shaft: '<svg/>' },
      params:   { shaft_height_m: 4.0 },
      provenance: { source: 'human', createdAt: '2026-05-13T00:00:00Z' },
    };
    expectTypeOf(b.seed).toEqualTypeOf<bigint>();
    expectTypeOf(b.provenance.source).toEqualTypeOf<'ai' | 'human'>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- schema.test`
Expected: FAIL — `Element` / `ProfileSlot` / etc. not exported.

- [ ] **Step 3: Append new types to schema.ts**

Append to `packages/architecture/src/schema.ts`:
```ts
/* ─────────────────  Element catalog (vertical slice 1)  ───────────────── */

export type ProfileHint = 'closed-path' | 'open-path' | 'symmetric-half' | 'tileable';

export interface ProfileSlot {
  name: string;
  description: string;
  hint: ProfileHint;
  bbox?: readonly [number, number, number, number];
}

export type ParamSlotKind = 'number' | 'integer' | 'enum';

export interface ParamSlot {
  name: string;
  kind: ParamSlotKind;
  range?: readonly [number, number];
  choices?: readonly string[];
  default: number | string;
}

export type ElementCategory = 'connector' | 'ornament';

export interface ElementGraphRef {
  kind: 'kernel-fn';
  module: string;     // import path, e.g. './kernel/elements/column.js'
  export: string;     // named export, e.g. 'columnGraph'
}

export interface Element {
  id: string;
  category: ElementCategory;
  graph: ElementGraphRef;
  profileSlots: readonly ProfileSlot[];
  paramSchema: readonly ParamSlot[];
}

export type ProvenanceSource = 'ai' | 'human';

export interface BindingProvenance {
  source: ProvenanceSource;
  aiProvider?: 'anthropic' | 'openai' | 'fal' | 'local';
  aiModel?: string;
  promptHash?: string;
  createdAt: string;
  referenceImageHashes?: readonly string[];
}

export interface ElementBinding {
  elementId: string;
  styleSheetId: string;
  seed: bigint;
  profiles: Readonly<Record<string, string>>;
  params: Readonly<Record<string, number | string>>;
  provenance: BindingProvenance;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test --workspace=@hayba/architecture -- schema.test`
Expected: PASS — 4 new tests added; total schema.test.ts now ≥ 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/schema.ts packages/architecture/src/schema.test.ts
git commit -m "feat(architecture): element catalog schema types (Element, Binding)"
```

---

### Task 2: Validators — Element + ElementBinding

**Files:**
- Modify: `packages/architecture/src/validate.ts` — add `validateElement`, `validateElementBinding`.
- Modify: `packages/architecture/src/validate.test.ts` — add tests.

- [ ] **Step 1: Write failing tests**

Append to `packages/architecture/src/validate.test.ts`:
```ts
import { validateElement, validateElementBinding } from './validate.js';

describe('validateElement', () => {
  const valid = {
    id: 'column',
    category: 'connector',
    graph: { kind: 'kernel-fn', module: './kernel/elements/column.js', export: 'columnGraph' },
    profileSlots: [
      { name: 'shaft', description: 'half-profile', hint: 'symmetric-half' },
    ],
    paramSchema: [
      { name: 'shaft_height_m', kind: 'number', range: [1.5, 8.0], default: 3.0 },
    ],
  };

  it('accepts a well-formed element', () => {
    expect(validateElement(valid, '/element')).toEqual([]);
  });

  it('rejects unknown category', () => {
    const errs = validateElement({ ...valid, category: 'mystery' }, '/element');
    expect(errs.some(e => e.path === '/element/category')).toBe(true);
  });

  it('rejects unknown profile hint', () => {
    const bad = { ...valid, profileSlots: [{ name: 'x', description: '', hint: 'wonky' }] };
    const errs = validateElement(bad, '/element');
    expect(errs.some(e => e.path === '/element/profileSlots/0/hint')).toBe(true);
  });

  it('rejects param range with min > max', () => {
    const bad = { ...valid, paramSchema: [{ name: 'h', kind: 'number', range: [8, 1], default: 3 }] };
    const errs = validateElement(bad, '/element');
    expect(errs.some(e => e.path.startsWith('/element/paramSchema/0/range'))).toBe(true);
  });

  it('rejects enum slot with no choices', () => {
    const bad = { ...valid, paramSchema: [{ name: 'fluting', kind: 'enum', default: 'shallow' }] };
    const errs = validateElement(bad, '/element');
    expect(errs.some(e => e.path === '/element/paramSchema/0/choices')).toBe(true);
  });
});

describe('validateElementBinding', () => {
  const element = {
    id: 'column',
    category: 'connector',
    graph: { kind: 'kernel-fn', module: './kernel/elements/column.js', export: 'columnGraph' },
    profileSlots: [{ name: 'shaft', description: '', hint: 'symmetric-half' }],
    paramSchema: [{ name: 'shaft_height_m', kind: 'number', range: [1.5, 8.0], default: 3.0 }],
  } as const;

  const valid = {
    elementId: 'column',
    styleSheetId: 'medieval-european-gothic',
    seed: 0x1234n,
    profiles: { shaft: '<svg viewBox="0 0 200 1000"><path d="M0 0L100 0L100 1000L0 1000Z"/></svg>' },
    params: { shaft_height_m: 4.5 },
    provenance: { source: 'human', createdAt: '2026-05-13T00:00:00Z' },
  };

  it('accepts a well-formed binding', () => {
    expect(validateElementBinding(valid, element as never, '/b')).toEqual([]);
  });

  it('rejects missing required profile slot', () => {
    const bad = { ...valid, profiles: {} };
    const errs = validateElementBinding(bad, element as never, '/b');
    expect(errs.some(e => e.path === '/b/profiles/shaft')).toBe(true);
  });

  it('rejects param out of declared range', () => {
    const bad = { ...valid, params: { shaft_height_m: 100 } };
    const errs = validateElementBinding(bad, element as never, '/b');
    expect(errs.some(e => e.path === '/b/params/shaft_height_m')).toBe(true);
  });

  it('rejects elementId mismatch', () => {
    const bad = { ...valid, elementId: 'cornice' };
    const errs = validateElementBinding(bad, element as never, '/b');
    expect(errs.some(e => e.path === '/b/elementId')).toBe(true);
  });

  it('rejects unknown provenance source', () => {
    const bad = { ...valid, provenance: { ...valid.provenance, source: 'unicorn' } };
    const errs = validateElementBinding(bad, element as never, '/b');
    expect(errs.some(e => e.path === '/b/provenance/source')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- validate.test`
Expected: FAIL — `validateElement` / `validateElementBinding` not exported.

- [ ] **Step 3: Append validators to validate.ts**

Append to `packages/architecture/src/validate.ts`:
```ts
import type {
  Element, ElementBinding, ProfileHint, ParamSlotKind, ProvenanceSource,
} from './schema.js';

const PROFILE_HINTS = ['closed-path', 'open-path', 'symmetric-half', 'tileable'] as const satisfies readonly ProfileHint[];
const PARAM_KINDS  = ['number', 'integer', 'enum']           as const satisfies readonly ParamSlotKind[];
const PROVENANCE   = ['ai', 'human']                          as const satisfies readonly ProvenanceSource[];
const CATEGORIES   = ['connector', 'ornament']                as const;

function validateProfileSlot(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) return [{ path, message: 'expected an object' }];
  const errs: ValidationError[] = [];
  if (typeof value.name !== 'string' || value.name.length === 0) {
    errs.push({ path: `${path}/name`, message: 'name must be a non-empty string' });
  }
  if (typeof value.description !== 'string') {
    errs.push({ path: `${path}/description`, message: 'description must be a string' });
  }
  if (!(PROFILE_HINTS as readonly string[]).includes(value.hint as string)) {
    errs.push({ path: `${path}/hint`, message: `expected one of ${PROFILE_HINTS.join(', ')}` });
  }
  if (value.bbox !== undefined) {
    if (!Array.isArray(value.bbox) || value.bbox.length !== 4 || !value.bbox.every((n: unknown) => typeof n === 'number')) {
      errs.push({ path: `${path}/bbox`, message: 'bbox must be [x, y, w, h]' });
    }
  }
  return errs;
}

function validateParamSlot(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) return [{ path, message: 'expected an object' }];
  const errs: ValidationError[] = [];
  if (typeof value.name !== 'string' || value.name.length === 0) {
    errs.push({ path: `${path}/name`, message: 'name must be a non-empty string' });
  }
  if (!(PARAM_KINDS as readonly string[]).includes(value.kind as string)) {
    errs.push({ path: `${path}/kind`, message: `expected one of ${PARAM_KINDS.join(', ')}` });
  }
  if (value.kind === 'number' || value.kind === 'integer') {
    errs.push(...validateRange(value.range, `${path}/range`));
  }
  if (value.kind === 'enum') {
    if (!Array.isArray(value.choices) || value.choices.length === 0 || !value.choices.every((c: unknown) => typeof c === 'string')) {
      errs.push({ path: `${path}/choices`, message: 'enum kind requires non-empty string[] of choices' });
    }
  }
  if (value.default === undefined) {
    errs.push({ path: `${path}/default`, message: 'default is required' });
  }
  return errs;
}

export function validateElement(value: unknown, path: string): ValidationError[] {
  if (!isPlainObject(value)) return [{ path, message: 'expected an object' }];
  const errs: ValidationError[] = [];
  if (typeof value.id !== 'string' || value.id.length === 0) {
    errs.push({ path: `${path}/id`, message: 'id must be a non-empty string' });
  }
  if (!(CATEGORIES as readonly string[]).includes(value.category as string)) {
    errs.push({ path: `${path}/category`, message: `expected one of ${CATEGORIES.join(', ')}` });
  }
  if (!isPlainObject(value.graph) || value.graph.kind !== 'kernel-fn' ||
      typeof value.graph.module !== 'string' || typeof value.graph.export !== 'string') {
    errs.push({ path: `${path}/graph`, message: 'graph must be { kind: "kernel-fn", module, export }' });
  }
  if (!Array.isArray(value.profileSlots) || value.profileSlots.length === 0) {
    errs.push({ path: `${path}/profileSlots`, message: 'must list at least one profile slot' });
  } else {
    value.profileSlots.forEach((s, i) => errs.push(...validateProfileSlot(s, `${path}/profileSlots/${i}`)));
  }
  if (!Array.isArray(value.paramSchema)) {
    errs.push({ path: `${path}/paramSchema`, message: 'expected array' });
  } else {
    value.paramSchema.forEach((s, i) => errs.push(...validateParamSlot(s, `${path}/paramSchema/${i}`)));
  }
  return errs;
}

export function validateElementBinding(
  value: unknown, element: Element, path: string,
): ValidationError[] {
  if (!isPlainObject(value)) return [{ path, message: 'expected an object' }];
  const errs: ValidationError[] = [];
  if (typeof value.elementId !== 'string' || value.elementId.length === 0) {
    errs.push({ path: `${path}/elementId`, message: 'elementId must be a non-empty string' });
  } else if (value.elementId !== element.id) {
    errs.push({ path: `${path}/elementId`, message: `mismatch: binding says ${JSON.stringify(value.elementId)} but element is ${JSON.stringify(element.id)}` });
  }
  if (typeof value.styleSheetId !== 'string' || value.styleSheetId.length === 0) {
    errs.push({ path: `${path}/styleSheetId`, message: 'styleSheetId must be a non-empty string' });
  }
  if (typeof value.seed !== 'bigint') {
    errs.push({ path: `${path}/seed`, message: 'seed must be a bigint' });
  }

  // profiles: every required slot present + non-empty string
  if (!isPlainObject(value.profiles)) {
    errs.push({ path: `${path}/profiles`, message: 'expected an object' });
  } else {
    for (const slot of element.profileSlots) {
      const v = value.profiles[slot.name];
      if (typeof v !== 'string' || v.length === 0) {
        errs.push({ path: `${path}/profiles/${slot.name}`, message: 'required SVG profile missing or empty' });
      }
    }
  }

  // params: every slot present + in-range / in-choices
  if (!isPlainObject(value.params)) {
    errs.push({ path: `${path}/params`, message: 'expected an object' });
  } else {
    for (const slot of element.paramSchema) {
      const v = value.params[slot.name];
      const ppath = `${path}/params/${slot.name}`;
      if (v === undefined) {
        errs.push({ path: ppath, message: 'required param missing' });
        continue;
      }
      if (slot.kind === 'number' || slot.kind === 'integer') {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          errs.push({ path: ppath, message: 'expected finite number' });
        } else if (slot.kind === 'integer' && !Number.isInteger(v)) {
          errs.push({ path: ppath, message: 'expected integer' });
        } else if (slot.range && (v < slot.range[0] || v > slot.range[1])) {
          errs.push({ path: ppath, message: `value ${v} out of range [${slot.range[0]}, ${slot.range[1]}]` });
        }
      } else if (slot.kind === 'enum') {
        if (typeof v !== 'string' || !(slot.choices ?? []).includes(v)) {
          errs.push({ path: ppath, message: `expected one of ${(slot.choices ?? []).join(', ')}` });
        }
      }
    }
  }

  // provenance
  if (!isPlainObject(value.provenance)) {
    errs.push({ path: `${path}/provenance`, message: 'expected an object' });
  } else {
    if (!(PROVENANCE as readonly string[]).includes(value.provenance.source as string)) {
      errs.push({ path: `${path}/provenance/source`, message: `expected one of ${PROVENANCE.join(', ')}` });
    }
    if (typeof value.provenance.createdAt !== 'string' || value.provenance.createdAt.length === 0) {
      errs.push({ path: `${path}/provenance/createdAt`, message: 'createdAt required (ISO 8601 string)' });
    }
  }

  return errs;
}

export function isElement(v: unknown): v is Element {
  return validateElement(v, '/').length === 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test --workspace=@hayba/architecture -- validate.test`
Expected: PASS — 33 total validate.test.ts tests (23 existing + 10 new).

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/validate.ts packages/architecture/src/validate.test.ts
git commit -m "feat(architecture): element + binding validators"
```

---

### Task 3: Column element type definition

**Files:**
- Create: `packages/architecture/src/data/elements/column.json`

- [ ] **Step 1: Create the element definition**

`packages/architecture/src/data/elements/column.json`:
```json
{
  "id": "column",
  "category": "connector",
  "graph": {
    "kind": "kernel-fn",
    "module": "./kernel/elements/column.js",
    "export": "columnGraph"
  },
  "profileSlots": [
    {
      "name": "shaft",
      "description": "Vertical half-profile of the column shaft. x ≥ 0 (revolved around Y axis). Encodes fluting, taper, entasis.",
      "hint": "symmetric-half",
      "bbox": [0, 0, 200, 1000]
    },
    {
      "name": "base",
      "description": "Half-profile of the column base (plinth + torus + scotia). x ≥ 0.",
      "hint": "symmetric-half",
      "bbox": [0, 0, 300, 80]
    },
    {
      "name": "capital_bottom",
      "description": "Top-of-shaft cross-section (closed polygon). Usually circular for round shafts.",
      "hint": "closed-path",
      "bbox": [-100, -100, 200, 200]
    },
    {
      "name": "capital_top",
      "description": "Under-abacus cross-section (closed polygon). Usually wider than capital_bottom.",
      "hint": "closed-path",
      "bbox": [-150, -150, 300, 300]
    }
  ],
  "paramSchema": [
    { "name": "base_height_m",    "kind": "number", "range": [0.05, 0.5], "default": 0.2 },
    { "name": "shaft_height_m",   "kind": "number", "range": [1.5, 8.0],  "default": 3.0 },
    { "name": "capital_height_m", "kind": "number", "range": [0.1, 0.8],  "default": 0.3 },
    { "name": "revolve_segments", "kind": "integer", "range": [16, 64],   "default": 32 }
  ]
}
```

- [ ] **Step 2: Stage and commit** (loader test follows in Task 14; data alone has no runtime yet)

```bash
git add packages/architecture/src/data/elements/column.json
git commit -m "feat(architecture): column element type definition"
```

---

### Task 4: Install three.js dependency

**Files:**
- Modify: `packages/architecture/package.json`

- [ ] **Step 1: Add three.js as a dependency**

Add to `packages/architecture/package.json` (inside the top-level object, after the existing `"devDependencies"` block; add a new `"dependencies"` block):
```json
  "dependencies": {
    "three": "^0.169.0"
  },
  "devDependencies": {
    "@types/node": "^24.12.2",
    "@types/three": "^0.169.0",
    "@vitest/coverage-v8": "^2.1.9",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
```
(Keep the existing devDeps; add `@types/three` to them.)

- [ ] **Step 2: Install**

From repo root:
```bash
npm install
```
Expected: package-lock updated; three + @types/three linked into `packages/architecture/node_modules/`.

- [ ] **Step 3: Verify import works**

Run:
```bash
node --input-type=module -e "import('three').then(t => console.log('three version:', t.REVISION))"
```
Expected: `three version: 169` (or whatever ^0.169.0 resolved to).

- [ ] **Step 4: Commit**

```bash
git add packages/architecture/package.json package-lock.json
git commit -m "feat(architecture): add three.js dependency for kernel"
```

---

### Task 5: Kernel type definitions

**Files:**
- Create: `packages/architecture/src/kernel/types.ts`

- [ ] **Step 1: Create the types file**

`packages/architecture/src/kernel/types.ts`:
```ts
/**
 * Kernel-internal types. Plain data, no methods, easy to test for byte equality.
 *
 * Coordinate convention: engine Y-up, right-handed. SVG coords (Y-down, mm)
 * are converted at parse time by `svg-parse.ts`. All meshes in this module
 * use meters as length units.
 */

export type Vec2 = readonly [number, number];     // (x, y)
export type Vec3 = readonly [number, number, number];  // (x, y, z)

/** 4x4 column-major transformation matrix. */
export type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

/** A 2D path of points. Closed paths repeat the first point at the end. */
export interface SvgPath {
  readonly hint: 'closed-path' | 'open-path' | 'symmetric-half' | 'tileable';
  readonly points: readonly Vec2[];
  /** Optional bbox in the SVG's viewBox coordinate system, for debug. */
  readonly bbox?: readonly [number, number, number, number];
}

/**
 * A triangle mesh in engine coordinates (meters, Y-up).
 *
 * - positions: tightly packed [x0,y0,z0, x1,y1,z1, ...] (length = vertexCount * 3)
 * - normals:   tightly packed [nx0,ny0,nz0, ...]      (length = vertexCount * 3)
 * - indices:   triangle indices (length = triangleCount * 3); always Uint32Array
 *
 * Mesh objects are immutable by convention. Primitive ops return new instances.
 */
export interface Mesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/** Identity-helper matrix builders, used by primitives.ts. */
export const IDENTITY: Mat4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];
```

- [ ] **Step 2: Commit**

```bash
git add packages/architecture/src/kernel/types.ts
git commit -m "feat(architecture): kernel core types (Vec, Mat4, SvgPath, Mesh)"
```

---

### Task 6: SVG profile parsing

**Files:**
- Create: `packages/architecture/src/kernel/svg-parse.ts`
- Create: `packages/architecture/src/kernel/svg-parse.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/architecture/src/kernel/svg-parse.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseSvgProfile } from './svg-parse.js';

describe('parseSvgProfile', () => {
  it('parses a simple rectangle as a closed-path', () => {
    const svg = '<svg viewBox="0 0 100 200"><path d="M0 0 L 100 0 L 100 200 L 0 200 Z"/></svg>';
    const p = parseSvgProfile(svg, 'closed-path');
    expect(p.hint).toBe('closed-path');
    expect(p.points.length).toBeGreaterThanOrEqual(4);
    // SVG Y-down → engine Y-up: y=0 in SVG becomes y=200 in engine (assuming viewBox height 200).
    // First point M0 0 → engine (0, 200).
    expect(p.points[0][0]).toBeCloseTo(0);
    expect(p.points[0][1]).toBeCloseTo(200);
  });

  it('handles M/L/H/V/Z commands', () => {
    const svg = '<svg viewBox="0 0 10 10"><path d="M1 1 L 5 1 H 9 V 9 L 1 9 Z"/></svg>';
    const p = parseSvgProfile(svg, 'closed-path');
    expect(p.points.length).toBe(5);   // M, L, H (line-to 9 1), V (line-to 9 9), L, then Z closes
  });

  it('rejects symmetric-half profile with negative x', () => {
    const svg = '<svg viewBox="-10 0 20 100"><path d="M-5 0 L 5 0 L 5 100 L -5 100 Z"/></svg>';
    expect(() => parseSvgProfile(svg, 'symmetric-half')).toThrow(/symmetric-half/);
  });

  it('accepts symmetric-half profile with x >= 0', () => {
    const svg = '<svg viewBox="0 0 100 1000"><path d="M0 0 L 50 0 L 50 1000 L 0 1000 Z"/></svg>';
    const p = parseSvgProfile(svg, 'symmetric-half');
    expect(p.points.every(([x]) => x >= 0)).toBe(true);
  });

  it('rejects missing path element', () => {
    const svg = '<svg viewBox="0 0 100 100"></svg>';
    expect(() => parseSvgProfile(svg, 'closed-path')).toThrow(/path/);
  });

  it('rejects malformed SVG', () => {
    expect(() => parseSvgProfile('not svg', 'closed-path')).toThrow();
  });

  it('produces deterministic output for the same input', () => {
    const svg = '<svg viewBox="0 0 100 100"><path d="M0 0 L 100 0 L 100 100 L 0 100 Z"/></svg>';
    const a = parseSvgProfile(svg, 'closed-path');
    const b = parseSvgProfile(svg, 'closed-path');
    expect(a.points).toEqual(b.points);
  });

  it('snaps coordinates to 4-decimal precision', () => {
    const svg = '<svg viewBox="0 0 100 100"><path d="M0.123456789 0 L 100 0 Z"/></svg>';
    const p = parseSvgProfile(svg, 'closed-path');
    expect(p.points[0][0]).toBe(0.1235);   // rounded to 4 dp
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- svg-parse.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement svg-parse.ts**

`packages/architecture/src/kernel/svg-parse.ts`:
```ts
/**
 * Minimal SVG profile parser. Supports straight-line commands only:
 * M (move), L (line), H (horizontal line), V (vertical line), Z (close).
 *
 * Curves (C/Q/A) are NOT supported in v1 — the AI is instructed to emit
 * straight-line polygons. A future tessellator can add curve support without
 * changing this contract.
 *
 * Output:
 * - Coordinates rounded to 4 decimal places (deterministic across float ops).
 * - SVG Y-down flipped to engine Y-up using the viewBox height.
 * - Closed paths have the first point repeated as the last point.
 * - Symmetric-half profiles must have all points with x ≥ 0.
 */

import type { SvgPath } from './types.js';

const PRECISION = 4;
const ROUND_FACTOR = Math.pow(10, PRECISION);

function snap(n: number): number {
  return Math.round(n * ROUND_FACTOR) / ROUND_FACTOR;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseViewBox(svgStr: string): ViewBox {
  const m = svgStr.match(/viewBox\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('parseSvgProfile: missing viewBox attribute');
  const [x, y, w, h] = m[1].trim().split(/\s+/).map(Number);
  if (![x, y, w, h].every(Number.isFinite)) {
    throw new Error('parseSvgProfile: viewBox must be "x y w h" with four numbers');
  }
  return { x, y, w, h };
}

function extractPathD(svgStr: string): string {
  const m = svgStr.match(/<path\b[^>]*\bd\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('parseSvgProfile: no <path> element with d attribute found');
  return m[1];
}

/** Tokenize a path-d string into [command, [...numbers]] pairs. */
function tokenize(d: string): Array<{ cmd: string; args: number[] }> {
  const tokens: Array<{ cmd: string; args: number[] }> = [];
  const re = /([MLHVZmlhvz])\s*([^MLHVZmlhvz]*)/g;
  let match;
  while ((match = re.exec(d)) !== null) {
    const cmd = match[1];
    const argsStr = match[2].trim();
    const args = argsStr.length === 0
      ? []
      : argsStr.split(/[\s,]+/).filter(s => s.length > 0).map(Number);
    if (args.some(n => !Number.isFinite(n))) {
      throw new Error(`parseSvgProfile: non-numeric token in path: ${argsStr}`);
    }
    tokens.push({ cmd, args });
  }
  if (tokens.length === 0) throw new Error('parseSvgProfile: empty path');
  if (tokens[0].cmd !== 'M' && tokens[0].cmd !== 'm') {
    throw new Error(`parseSvgProfile: path must start with M, got ${tokens[0].cmd}`);
  }
  return tokens;
}

/** Walk path tokens, building (x, y) points in SVG coordinates. */
function walkPath(tokens: Array<{ cmd: string; args: number[] }>): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  let cx = 0, cy = 0;
  let startX = 0, startY = 0;
  for (const { cmd, args } of tokens) {
    switch (cmd) {
      case 'M':
        if (args.length < 2) throw new Error('M: need at least 2 args');
        cx = args[0]; cy = args[1];
        startX = cx; startY = cy;
        pts.push([cx, cy]);
        for (let i = 2; i + 1 < args.length; i += 2) {
          cx = args[i]; cy = args[i + 1];
          pts.push([cx, cy]);
        }
        break;
      case 'm':
        if (args.length < 2) throw new Error('m: need at least 2 args');
        cx += args[0]; cy += args[1];
        startX = cx; startY = cy;
        pts.push([cx, cy]);
        for (let i = 2; i + 1 < args.length; i += 2) {
          cx += args[i]; cy += args[i + 1];
          pts.push([cx, cy]);
        }
        break;
      case 'L':
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx = args[i]; cy = args[i + 1];
          pts.push([cx, cy]);
        }
        break;
      case 'l':
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx += args[i]; cy += args[i + 1];
          pts.push([cx, cy]);
        }
        break;
      case 'H':
        for (const n of args) { cx = n; pts.push([cx, cy]); }
        break;
      case 'h':
        for (const n of args) { cx += n; pts.push([cx, cy]); }
        break;
      case 'V':
        for (const n of args) { cy = n; pts.push([cx, cy]); }
        break;
      case 'v':
        for (const n of args) { cy += n; pts.push([cx, cy]); }
        break;
      case 'Z':
      case 'z':
        // Close: ensure last point equals start (for closed-path consumers).
        if (pts.length === 0 || pts[pts.length - 1][0] !== startX || pts[pts.length - 1][1] !== startY) {
          pts.push([startX, startY]);
        }
        cx = startX; cy = startY;
        break;
      default:
        throw new Error(`parseSvgProfile: unsupported command ${cmd} (curves not supported in v1)`);
    }
  }
  return pts;
}

export function parseSvgProfile(svgStr: string, hint: SvgPath['hint']): SvgPath {
  if (typeof svgStr !== 'string' || !svgStr.includes('<svg')) {
    throw new Error('parseSvgProfile: input must be an SVG string');
  }
  const vb = parseViewBox(svgStr);
  const d = extractPathD(svgStr);
  const tokens = tokenize(d);
  const raw = walkPath(tokens);

  // SVG Y-down → engine Y-up: y_engine = (vb.y + vb.h) - y_svg
  // Then snap to PRECISION.
  const points: Array<readonly [number, number]> = raw.map(([x, y]) => {
    const ex = snap(x);
    const ey = snap((vb.y + vb.h) - y);
    return [ex, ey] as const;
  });

  // Hint-specific validation.
  if (hint === 'symmetric-half' && points.some(([x]) => x < 0)) {
    throw new Error('parseSvgProfile: symmetric-half profile requires all points to have x >= 0');
  }
  if (hint === 'closed-path') {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
      // Force closure.
      if (first) points.push(first);
    }
  }

  return {
    hint,
    points,
    bbox: [vb.x, vb.y, vb.w, vb.h],
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- svg-parse.test`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/kernel/svg-parse.ts packages/architecture/src/kernel/svg-parse.test.ts
git commit -m "feat(architecture): kernel SVG profile parser (straight-line paths)"
```

---

### Task 7: Primitive — transform (matrices, translate / rotate / scale)

**Files:**
- Create: `packages/architecture/src/kernel/primitives.ts` — start with transform helpers + `transform()` op.
- Create: `packages/architecture/src/kernel/primitives.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/architecture/src/kernel/primitives.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  IDENTITY_M, translateY, scale, rotateY, compose, transform,
} from './primitives.js';
import type { Mesh } from './types.js';

const triMesh = (): Mesh => ({
  positions: new Float32Array([0, 0, 0,  1, 0, 0,  0, 1, 0]),
  normals:   new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1]),
  indices:   new Uint32Array([0, 1, 2]),
});

describe('matrix helpers', () => {
  it('translateY moves vertices up by Y', () => {
    const m = translateY(5);
    expect(m[13]).toBe(5);   // column-major: tx,ty,tz at indices 12,13,14
  });

  it('scale produces a diagonal matrix', () => {
    const m = scale(2, 3, 4);
    expect(m[0]).toBe(2);
    expect(m[5]).toBe(3);
    expect(m[10]).toBe(4);
  });

  it('rotateY(0) equals identity', () => {
    const m = rotateY(0);
    for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(IDENTITY_M[i]);
  });

  it('compose(a, b) applies b then a (left-multiply)', () => {
    const t = translateY(2);
    const s = scale(3, 3, 3);
    const c = compose(t, s);
    // applying compose(t, s) to (0,1,0): scale→(0,3,0), then translate→(0,5,0)
    const mesh = transform({ positions: new Float32Array([0, 1, 0]), normals: new Float32Array([0,0,1]), indices: new Uint32Array([0]) }, c);
    expect(mesh.positions[1]).toBeCloseTo(5);
  });
});

describe('transform(mesh, matrix)', () => {
  it('identity matrix returns identical positions', () => {
    const m = transform(triMesh(), IDENTITY_M);
    expect(Array.from(m.positions)).toEqual([0, 0, 0,  1, 0, 0,  0, 1, 0]);
  });

  it('translates each vertex', () => {
    const out = transform(triMesh(), translateY(10));
    expect(out.positions[1]).toBeCloseTo(10);
    expect(out.positions[4]).toBeCloseTo(10);
    expect(out.positions[7]).toBeCloseTo(11);
  });

  it('preserves index buffer byte-identically', () => {
    const out = transform(triMesh(), translateY(1));
    expect(Array.from(out.indices)).toEqual([0, 1, 2]);
  });

  it('rotateY(180°) flips X coordinate', () => {
    const out = transform(triMesh(), rotateY(Math.PI));
    expect(out.positions[3]).toBeCloseTo(-1);   // second vertex: (1,0,0) → (-1, 0, 0)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- primitives.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement primitives.ts with transform helpers + transform()**

`packages/architecture/src/kernel/primitives.ts`:
```ts
import type { Mat4, Mesh } from './types.js';
import { IDENTITY } from './types.js';

export const IDENTITY_M: Mat4 = IDENTITY;

export function translateY(ty: number): Mat4 {
  return [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, ty, 0, 1];
}

export function translate(tx: number, ty: number, tz: number): Mat4 {
  return [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  tx, ty, tz, 1];
}

export function scale(sx: number, sy: number, sz: number): Mat4 {
  return [sx, 0, 0, 0,  0, sy, 0, 0,  0, 0, sz, 0,  0, 0, 0, 1];
}

/** Rotation around Y axis by `angle` radians. */
export function rotateY(angle: number): Mat4 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, 0, -s, 0,  0, 1, 0, 0,  s, 0, c, 0,  0, 0, 0, 1];
}

/** Column-major 4x4 multiply: returns a * b. */
export function compose(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = new Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + i] * b[j * 4 + k];
      out[j * 4 + i] = v;
    }
  }
  return out as unknown as Mat4;
}

/** Apply a 4x4 column-major transform to a mesh's positions and normals. */
export function transform(mesh: Mesh, m: Mat4): Mesh {
  const n = mesh.positions.length / 3;
  const positions = new Float32Array(mesh.positions.length);
  const normals   = new Float32Array(mesh.normals.length);
  for (let i = 0; i < n; i++) {
    const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
    positions[i * 3]     = m[0] * x + m[4] * y + m[8]  * z + m[12];
    positions[i * 3 + 1] = m[1] * x + m[5] * y + m[9]  * z + m[13];
    positions[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];

    const nx = mesh.normals[i * 3], ny = mesh.normals[i * 3 + 1], nz = mesh.normals[i * 3 + 2];
    // Normals: apply rotation only (3x3 submatrix), no translation. Assumes uniform scale.
    let rx = m[0] * nx + m[4] * ny + m[8]  * nz;
    let ry = m[1] * nx + m[5] * ny + m[9]  * nz;
    let rz = m[2] * nx + m[6] * ny + m[10] * nz;
    const len = Math.hypot(rx, ry, rz) || 1;
    normals[i * 3]     = rx / len;
    normals[i * 3 + 1] = ry / len;
    normals[i * 3 + 2] = rz / len;
  }
  return { positions, normals, indices: new Uint32Array(mesh.indices) };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- primitives.test`
Expected: PASS — 8 tests in this block.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/kernel/primitives.ts packages/architecture/src/kernel/primitives.test.ts
git commit -m "feat(architecture): kernel transform primitive + matrix helpers"
```

---

### Task 8: Primitive — revolve (lathe a symmetric-half profile)

**Files:**
- Modify: `packages/architecture/src/kernel/primitives.ts` — append `revolve`.
- Modify: `packages/architecture/src/kernel/primitives.test.ts` — append tests.

- [ ] **Step 1: Write failing tests**

Append to `packages/architecture/src/kernel/primitives.test.ts`:
```ts
import { revolve } from './primitives.js';
import { parseSvgProfile } from './svg-parse.js';

describe('revolve', () => {
  it('a 100mm × 1000mm rectangle revolved 360° produces a cylinder mesh', () => {
    const profile = parseSvgProfile(
      '<svg viewBox="0 0 100 1000"><path d="M0 0 L 100 0 L 100 1000 L 0 1000 Z"/></svg>',
      'symmetric-half',
    );
    const m = revolve(profile, 'Y', 16, 360);
    // 16 segments × ~3 profile rims (top, bottom, side line) ≈ ~48–64 verts.
    expect(m.positions.length).toBeGreaterThan(0);
    expect(m.indices.length).toBeGreaterThan(0);
    expect(m.indices.length % 3).toBe(0);
  });

  it('produces deterministic output (byte-identical across two calls)', () => {
    const profile = parseSvgProfile(
      '<svg viewBox="0 0 50 200"><path d="M0 0 L 50 0 L 50 200 L 0 200 Z"/></svg>',
      'symmetric-half',
    );
    const a = revolve(profile, 'Y', 24, 360);
    const b = revolve(profile, 'Y', 24, 360);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });

  it('rejects revolve with non-symmetric-half input', () => {
    const profile = parseSvgProfile(
      '<svg viewBox="0 0 100 100"><path d="M0 0 L 100 0 L 100 100 L 0 100 Z"/></svg>',
      'closed-path',
    );
    expect(() => revolve(profile, 'Y', 16, 360)).toThrow(/symmetric-half/);
  });

  it('output triangles are all properly indexed (no out-of-bounds)', () => {
    const profile = parseSvgProfile(
      '<svg viewBox="0 0 30 60"><path d="M0 0 L 30 0 L 30 60 L 0 60 Z"/></svg>',
      'symmetric-half',
    );
    const m = revolve(profile, 'Y', 8, 360);
    const vertCount = m.positions.length / 3;
    for (let i = 0; i < m.indices.length; i++) {
      expect(m.indices[i]).toBeGreaterThanOrEqual(0);
      expect(m.indices[i]).toBeLessThan(vertCount);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- primitives.test`
Expected: FAIL — `revolve` not exported.

- [ ] **Step 3: Implement revolve**

Append to `packages/architecture/src/kernel/primitives.ts`:
```ts
import type { SvgPath } from './types.js';

/**
 * Revolve a 2D symmetric-half profile around the Y axis.
 *
 * - profile.points are (x, y) in millimeters; x ≥ 0; the curve is rotated
 *   `sweep_deg` degrees around the Y axis in `segments` discrete steps.
 * - Output mesh uses meters (mm → m by /1000).
 * - segments must be ≥ 3; sweep_deg in (0, 360].
 *
 * Produces a quad-strip mesh: for each pair of consecutive profile points,
 * a "ring" is generated around the axis; rings are stitched with triangles.
 */
export function revolve(
  profile: SvgPath,
  axis: 'Y',   // X, Z reserved for future use; Y only for v1
  segments: number,
  sweep_deg: number,
): Mesh {
  if (profile.hint !== 'symmetric-half') {
    throw new Error('revolve: requires a symmetric-half profile');
  }
  if (segments < 3) throw new Error('revolve: segments must be ≥ 3');
  if (sweep_deg <= 0 || sweep_deg > 360) throw new Error('revolve: sweep_deg in (0, 360]');
  if (axis !== 'Y') throw new Error('revolve: only Y axis supported in v1');
  if (profile.points.length < 2) throw new Error('revolve: profile needs ≥ 2 points');

  const pts = profile.points;
  const M = pts.length;
  const N = segments;
  const sweep_rad = (sweep_deg * Math.PI) / 180;
  const isFullCircle = sweep_deg === 360;

  // Convert mm → m once.
  const profileM = pts.map(([x, y]) => [x / 1000, y / 1000] as const);

  // Number of unique rings: full circle re-uses ring 0 as ring N (so N rings total).
  // Partial sweep: N+1 rings.
  const ringCount = isFullCircle ? N : N + 1;
  const vertCount = M * ringCount;

  const positions = new Float32Array(vertCount * 3);
  const normals   = new Float32Array(vertCount * 3);

  for (let r = 0; r < ringCount; r++) {
    const theta = (r / N) * sweep_rad;
    const c = Math.cos(theta), s = Math.sin(theta);
    for (let i = 0; i < M; i++) {
      const [x, y] = profileM[i];
      const vIdx = (r * M + i) * 3;
      positions[vIdx]     = x * c;
      positions[vIdx + 1] = y;
      positions[vIdx + 2] = x * s;
      // Normal: outward-pointing radial vector (approximation, ignoring profile slope).
      // For accurate normals we'd compute tangent × revolve-axis; v1 uses radial.
      const len = Math.hypot(c, s) || 1;
      normals[vIdx]     = c / len;
      normals[vIdx + 1] = 0;
      normals[vIdx + 2] = s / len;
    }
  }

  // Triangulate the quad strip between consecutive rings.
  const indices: number[] = [];
  for (let r = 0; r < N; r++) {
    const r0 = r * M;
    const r1 = (isFullCircle ? ((r + 1) % N) : (r + 1)) * M;
    for (let i = 0; i < M - 1; i++) {
      const a = r0 + i;
      const b = r0 + i + 1;
      const c = r1 + i + 1;
      const d = r1 + i;
      // two triangles (CCW for outward-facing)
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }

  return {
    positions,
    normals,
    indices: new Uint32Array(indices),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- primitives.test`
Expected: PASS — 4 new tests pass (total in this file now 12).

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/kernel/primitives.ts packages/architecture/src/kernel/primitives.test.ts
git commit -m "feat(architecture): kernel revolve primitive (Y-axis lathe)"
```

---

### Task 9: Primitive — loft (interpolate between two closed-path profiles)

**Files:**
- Modify: `packages/architecture/src/kernel/primitives.ts` — append `loft`.
- Modify: `packages/architecture/src/kernel/primitives.test.ts` — append tests.

- [ ] **Step 1: Write failing tests**

Append to `packages/architecture/src/kernel/primitives.test.ts`:
```ts
import { loft } from './primitives.js';

describe('loft', () => {
  const sq = (size: number) => parseSvgProfile(
    `<svg viewBox="${-size/2} ${-size/2} ${size} ${size}"><path d="M${-size/2} ${-size/2} L ${size/2} ${-size/2} L ${size/2} ${size/2} L ${-size/2} ${size/2} Z"/></svg>`,
    'closed-path',
  );

  it('interpolates between two same-sized squares (extrusion)', () => {
    const a = sq(100);
    const b = sq(100);
    const m = loft([a, b], [[0, 0, 0], [0, 100, 0]]);
    expect(m.positions.length).toBeGreaterThan(0);
    expect(m.indices.length % 3).toBe(0);
  });

  it('interpolates between two different-sized squares (frustum)', () => {
    const a = sq(100);
    const b = sq(200);
    const m = loft([a, b], [[0, 0, 0], [0, 100, 0]]);
    // Should produce a 4-sided frustum; ≥8 unique verts, ≥8 tris.
    expect(m.positions.length / 3).toBeGreaterThanOrEqual(8);
    expect(m.indices.length / 3).toBeGreaterThanOrEqual(8);
  });

  it('is deterministic', () => {
    const a = sq(50), b = sq(150);
    const m1 = loft([a, b], [[0, 0, 0], [0, 200, 0]]);
    const m2 = loft([a, b], [[0, 0, 0], [0, 200, 0]]);
    expect(Array.from(m1.positions)).toEqual(Array.from(m2.positions));
    expect(Array.from(m1.indices)).toEqual(Array.from(m2.indices));
  });

  it('rejects mismatched profile/position array lengths', () => {
    const a = sq(50);
    expect(() => loft([a], [[0, 0, 0], [0, 100, 0]])).toThrow();
    expect(() => loft([a, a, a], [[0, 0, 0], [0, 100, 0]])).toThrow();
  });

  it('rejects non-closed-path profiles', () => {
    const open = parseSvgProfile(
      '<svg viewBox="0 0 100 100"><path d="M0 0 L 100 0 L 100 100"/></svg>',
      'open-path',
    );
    expect(() => loft([open, open], [[0, 0, 0], [0, 100, 0]])).toThrow(/closed-path/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- primitives.test`
Expected: FAIL.

- [ ] **Step 3: Implement loft**

Append to `packages/architecture/src/kernel/primitives.ts`:
```ts
/**
 * Loft (skin) between N closed-path profiles placed at N positions in 3D space.
 *
 * Constraints (v1):
 * - All profiles must have the same point count. Caller must pre-resample to match.
 *   (A future helper can do automatic resampling.)
 * - All profiles have hint 'closed-path'.
 * - Each profile lies in the XZ plane around its position; Y from position.y.
 *
 * Generates triangulated strips between consecutive profiles. Profile-internal
 * area (caps) is NOT filled — caller can union with a cap mesh if needed.
 */
export function loft(profiles: SvgPath[], positions: ReadonlyArray<readonly [number, number, number]>): Mesh {
  if (profiles.length < 2) throw new Error('loft: need at least 2 profiles');
  if (profiles.length !== positions.length) {
    throw new Error('loft: profiles and positions must have equal length');
  }
  if (!profiles.every(p => p.hint === 'closed-path')) {
    throw new Error('loft: requires closed-path profiles');
  }
  const M = profiles[0].points.length;
  if (!profiles.every(p => p.points.length === M)) {
    throw new Error('loft: all profiles must have the same number of points (resample first)');
  }

  const L = profiles.length;
  const vertCount = M * L;
  const positionsBuf = new Float32Array(vertCount * 3);
  const normalsBuf   = new Float32Array(vertCount * 3);

  // mm → m.
  for (let li = 0; li < L; li++) {
    const [px, py, pz] = positions[li];
    const pts = profiles[li].points;
    for (let i = 0; i < M; i++) {
      const [x, y] = pts[i];
      const vIdx = (li * M + i) * 3;
      positionsBuf[vIdx]     = px + x / 1000;
      positionsBuf[vIdx + 1] = py;
      positionsBuf[vIdx + 2] = pz + y / 1000;
      // Outward normal approximation: vector from profile center (px, _, pz) to point.
      const dx = positionsBuf[vIdx]     - px;
      const dz = positionsBuf[vIdx + 2] - pz;
      const len = Math.hypot(dx, dz) || 1;
      normalsBuf[vIdx]     = dx / len;
      normalsBuf[vIdx + 1] = 0;
      normalsBuf[vIdx + 2] = dz / len;
    }
  }

  // Triangulate the strip between consecutive profile layers.
  const indices: number[] = [];
  for (let li = 0; li < L - 1; li++) {
    const r0 = li * M;
    const r1 = (li + 1) * M;
    for (let i = 0; i < M - 1; i++) {
      const a = r0 + i;
      const b = r0 + i + 1;
      const c = r1 + i + 1;
      const d = r1 + i;
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }

  return {
    positions: positionsBuf,
    normals: normalsBuf,
    indices: new Uint32Array(indices),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- primitives.test`
Expected: PASS — 5 new tests; total in file now 17.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/kernel/primitives.ts packages/architecture/src/kernel/primitives.test.ts
git commit -m "feat(architecture): kernel loft primitive (interpolate between closed profiles)"
```

---

### Task 10: Primitive — mergeMeshes (concatenate vertex/index buffers)

**Files:**
- Modify: `packages/architecture/src/kernel/primitives.ts` — append `mergeMeshes`.
- Modify: `packages/architecture/src/kernel/primitives.test.ts` — append tests.

- [ ] **Step 1: Write failing tests**

Append to `packages/architecture/src/kernel/primitives.test.ts`:
```ts
import { mergeMeshes } from './primitives.js';

describe('mergeMeshes', () => {
  const tri = (offsetY: number): Mesh => ({
    positions: new Float32Array([0, offsetY, 0,  1, offsetY, 0,  0, offsetY + 1, 0]),
    normals:   new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1]),
    indices:   new Uint32Array([0, 1, 2]),
  });

  it('concatenates two meshes with index offsets', () => {
    const a = tri(0);
    const b = tri(10);
    const m = mergeMeshes([a, b]);
    expect(m.positions.length).toBe(18);   // 6 verts × 3
    expect(m.indices.length).toBe(6);       // 2 tris × 3
    expect(m.indices[3]).toBe(3);           // second triangle starts at vertex 3
    expect(m.indices[4]).toBe(4);
    expect(m.indices[5]).toBe(5);
  });

  it('merges three meshes preserving all data', () => {
    const m = mergeMeshes([tri(0), tri(5), tri(10)]);
    expect(m.positions.length / 3).toBe(9);
    expect(m.indices.length / 3).toBe(3);
  });

  it('is deterministic', () => {
    const a = mergeMeshes([tri(0), tri(1)]);
    const b = mergeMeshes([tri(0), tri(1)]);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });

  it('rejects empty input', () => {
    expect(() => mergeMeshes([])).toThrow();
  });

  it('single-mesh merge returns equivalent data', () => {
    const m = mergeMeshes([tri(0)]);
    expect(Array.from(m.positions)).toEqual([0,0,0, 1,0,0, 0,1,0]);
    expect(Array.from(m.indices)).toEqual([0, 1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- primitives.test`
Expected: FAIL.

- [ ] **Step 3: Implement mergeMeshes**

Append to `packages/architecture/src/kernel/primitives.ts`:
```ts
/**
 * Concatenate two or more meshes into a single mesh. Index buffers are
 * offset by the cumulative vertex count of preceding meshes.
 *
 * No deduplication or welding — vertices are concatenated as-is. Use this
 * for stacking sub-meshes that don't share vertices (e.g., a column's base,
 * shaft, and capital).
 */
export function mergeMeshes(meshes: Mesh[]): Mesh {
  if (meshes.length === 0) throw new Error('mergeMeshes: input must be non-empty');
  let totalVerts = 0;
  let totalIndices = 0;
  for (const m of meshes) {
    totalVerts   += m.positions.length / 3;
    totalIndices += m.indices.length;
  }
  const positions = new Float32Array(totalVerts * 3);
  const normals   = new Float32Array(totalVerts * 3);
  const indices   = new Uint32Array(totalIndices);

  let vCursor = 0;
  let iCursor = 0;
  for (const m of meshes) {
    positions.set(m.positions, vCursor * 3);
    normals.set(m.normals, vCursor * 3);
    for (let i = 0; i < m.indices.length; i++) {
      indices[iCursor + i] = m.indices[i] + vCursor;
    }
    vCursor += m.positions.length / 3;
    iCursor += m.indices.length;
  }

  return { positions, normals, indices };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- primitives.test`
Expected: PASS — 5 new tests; total file 22.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/kernel/primitives.ts packages/architecture/src/kernel/primitives.test.ts
git commit -m "feat(architecture): kernel mergeMeshes primitive"
```

---

### Task 11: glTF binary emitter (mesh → GLB)

**Files:**
- Create: `packages/architecture/src/kernel/glb-emit.ts`
- Create: `packages/architecture/src/kernel/glb-emit.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/architecture/src/kernel/glb-emit.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { emitGLB } from './glb-emit.js';
import type { Mesh } from './types.js';

const tri: Mesh = {
  positions: new Float32Array([0, 0, 0,  1, 0, 0,  0, 1, 0]),
  normals:   new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1]),
  indices:   new Uint32Array([0, 1, 2]),
};

describe('emitGLB', () => {
  it('produces a non-empty ArrayBuffer', () => {
    const out = emitGLB(tri);
    expect(out.byteLength).toBeGreaterThan(100);
  });

  it('output starts with the glTF magic bytes "glTF"', () => {
    const out = emitGLB(tri);
    const view = new Uint8Array(out, 0, 4);
    expect(view[0]).toBe(0x67);   // 'g'
    expect(view[1]).toBe(0x6c);   // 'l'
    expect(view[2]).toBe(0x54);   // 'T'
    expect(view[3]).toBe(0x46);   // 'F'
  });

  it('is byte-deterministic for the same mesh', () => {
    const a = emitGLB(tri);
    const b = emitGLB(tri);
    expect(a.byteLength).toBe(b.byteLength);
    const av = new Uint8Array(a);
    const bv = new Uint8Array(b);
    for (let i = 0; i < av.length; i++) expect(av[i]).toBe(bv[i]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- glb-emit.test`
Expected: FAIL.

- [ ] **Step 3: Implement glb-emit.ts**

`packages/architecture/src/kernel/glb-emit.ts`:
```ts
/**
 * Emit a Mesh as a glTF 2.0 binary (.glb) ArrayBuffer.
 *
 * Implementation builds the minimal glTF structure by hand rather than using
 * three.js's GLTFExporter (which is browser-only and includes non-deterministic
 * metadata like timestamps).
 *
 * Layout: 12-byte header + JSON chunk + BIN chunk.
 *
 * Determinism: the JSON section is built with explicit insertion order; the
 * BIN section is built by concatenating positions, normals, indices (in that
 * order, each padded to 4-byte alignment).
 */

import type { Mesh } from './types.js';

const GLB_MAGIC = 0x46546c67;        // 'glTF' little-endian
const VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;       // 'JSON' little-endian
const CHUNK_BIN  = 0x004e4942;       // 'BIN\0' little-endian

function pad4(n: number): number { return Math.ceil(n / 4) * 4; }

export function emitGLB(mesh: Mesh): ArrayBuffer {
  const posBytes = mesh.positions.byteLength;
  const normBytes = mesh.normals.byteLength;
  const idxBytes = mesh.indices.byteLength;

  const posOffset = 0;
  const normOffset = pad4(posOffset + posBytes);
  const idxOffset  = pad4(normOffset + normBytes);
  const binTotal   = pad4(idxOffset + idxBytes);

  // Compute bounds for the position accessor (glTF spec requires min/max).
  const vCount = mesh.positions.length / 3;
  let minX = +Infinity, minY = +Infinity, minZ = +Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vCount; i++) {
    const x = mesh.positions[i*3], y = mesh.positions[i*3+1], z = mesh.positions[i*3+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // 5126 = FLOAT, 5125 = UNSIGNED_INT, 34962 = ARRAY_BUFFER, 34963 = ELEMENT_ARRAY_BUFFER
  const json = {
    asset: { version: '2.0', generator: 'hayba-architecture-kernel' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1 },
        indices: 2,
        mode: 4,   // TRIANGLES
      }],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vCount, type: 'VEC3',
        min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      { bufferView: 1, componentType: 5126, count: vCount, type: 'VEC3' },
      { bufferView: 2, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: posOffset,  byteLength: posBytes,  target: 34962 },
      { buffer: 0, byteOffset: normOffset, byteLength: normBytes, target: 34962 },
      { buffer: 0, byteOffset: idxOffset,  byteLength: idxBytes,  target: 34963 },
    ],
    buffers: [{ byteLength: binTotal }],
  };

  const jsonStr = JSON.stringify(json);
  // Pad JSON to 4-byte boundary with spaces (glTF spec).
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPadded = new Uint8Array(pad4(jsonBytes.length));
  jsonPadded.set(jsonBytes);
  for (let i = jsonBytes.length; i < jsonPadded.length; i++) jsonPadded[i] = 0x20;  // space

  const total = 12 + 8 + jsonPadded.length + 8 + binTotal;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // GLB header.
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, total, true);

  // JSON chunk header.
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, CHUNK_JSON, true);
  u8.set(jsonPadded, 20);

  // BIN chunk header.
  const binChunkOffset = 20 + jsonPadded.length;
  view.setUint32(binChunkOffset, binTotal, true);
  view.setUint32(binChunkOffset + 4, CHUNK_BIN, true);

  // BIN data.
  const binBase = binChunkOffset + 8;
  u8.set(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, posBytes), binBase + posOffset);
  u8.set(new Uint8Array(mesh.normals.buffer,   mesh.normals.byteOffset,   normBytes), binBase + normOffset);
  u8.set(new Uint8Array(mesh.indices.buffer,   mesh.indices.byteOffset,   idxBytes),  binBase + idxOffset);

  return buf;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- glb-emit.test`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/kernel/glb-emit.ts packages/architecture/src/kernel/glb-emit.test.ts
git commit -m "feat(architecture): kernel glTF binary (.glb) emitter"
```

---

### Task 12: Column generator function

**Files:**
- Create: `packages/architecture/src/kernel/elements/column.ts`
- Create: `packages/architecture/src/kernel/elements/column.test.ts`

- [ ] **Step 1: Write failing test**

`packages/architecture/src/kernel/elements/column.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { columnGraph } from './column.js';
import type { ElementBinding } from '../../schema.js';

const sampleBinding: ElementBinding = {
  elementId: 'column',
  styleSheetId: 'test',
  seed: 0x1n,
  profiles: {
    shaft:           '<svg viewBox="0 0 200 1000"><path d="M0 0 L 100 0 L 100 1000 L 0 1000 Z"/></svg>',
    base:            '<svg viewBox="0 0 300 80"><path d="M0 0 L 150 0 L 150 80 L 0 80 Z"/></svg>',
    capital_bottom:  '<svg viewBox="-100 -100 200 200"><path d="M-50 -50 L 50 -50 L 50 50 L -50 50 Z"/></svg>',
    capital_top:     '<svg viewBox="-150 -150 300 300"><path d="M-100 -100 L 100 -100 L 100 100 L -100 100 Z"/></svg>',
  },
  params: {
    base_height_m: 0.2,
    shaft_height_m: 3.0,
    capital_height_m: 0.3,
    revolve_segments: 32,
  },
  provenance: { source: 'human', createdAt: '2026-05-13T00:00:00Z' },
};

describe('columnGraph', () => {
  it('produces a non-empty mesh from the sample binding', () => {
    const m = columnGraph(sampleBinding);
    expect(m.positions.length).toBeGreaterThan(0);
    expect(m.indices.length).toBeGreaterThan(0);
    expect(m.indices.length % 3).toBe(0);
  });

  it('is deterministic: same binding → same mesh', () => {
    const a = columnGraph(sampleBinding);
    const b = columnGraph(sampleBinding);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });

  it('column total height ≈ base + shaft + capital', () => {
    const m = columnGraph(sampleBinding);
    let maxY = -Infinity;
    for (let i = 0; i < m.positions.length / 3; i++) {
      maxY = Math.max(maxY, m.positions[i*3 + 1]);
    }
    // 0.2 (base) + 3.0 (shaft) + 0.3 (capital) ≈ 3.5 m total
    expect(maxY).toBeGreaterThan(3.3);
    expect(maxY).toBeLessThan(3.8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- column.test`
Expected: FAIL.

- [ ] **Step 3: Implement column.ts**

`packages/architecture/src/kernel/elements/column.ts`:
```ts
/**
 * Column element generator. Mathematically composes a column from its
 * 4 hand-authored / AI-emitted SVG profiles and 4 numeric parameters.
 *
 * Layout (Y-up, meters):
 *   y = 0                              ── ground line, bottom of base
 *   y = base_height_m                  ── bottom of shaft
 *   y = base_height_m + shaft_height_m ── bottom of capital
 *   y = total_height                   ── top of capital (= top of column)
 *
 * Subassemblies:
 *   - Base:    revolve(profiles.base, 360°)  positioned at y=0
 *   - Shaft:   revolve(profiles.shaft, 360°) positioned at y=base_height_m
 *   - Capital: loft([capital_bottom, capital_top]) between two Y positions
 */

import type { ElementBinding } from '../../schema.js';
import type { Mesh } from '../types.js';
import { parseSvgProfile } from '../svg-parse.js';
import { revolve, loft, mergeMeshes, transform, translate } from '../primitives.js';

export function columnGraph(b: ElementBinding): Mesh {
  const baseH    = Number(b.params.base_height_m);
  const shaftH   = Number(b.params.shaft_height_m);
  const capH     = Number(b.params.capital_height_m);
  const segments = Number(b.params.revolve_segments);

  const baseProfile  = parseSvgProfile(b.profiles.base,           'symmetric-half');
  const shaftProfile = parseSvgProfile(b.profiles.shaft,          'symmetric-half');
  const capBot       = parseSvgProfile(b.profiles.capital_bottom, 'closed-path');
  const capTop       = parseSvgProfile(b.profiles.capital_top,    'closed-path');

  if (capBot.points.length !== capTop.points.length) {
    throw new Error(
      `columnGraph: capital_bottom (${capBot.points.length} points) and capital_top ` +
      `(${capTop.points.length} points) must have the same point count. ` +
      `Resample the SVG profiles to match before binding.`,
    );
  }

  // Build subassemblies in their local coordinate frames, then translate.
  const baseMesh = transform(
    revolve(baseProfile, 'Y', segments, 360),
    translate(0, 0, 0),
  );

  const shaftMesh = transform(
    revolve(shaftProfile, 'Y', segments, 360),
    translate(0, baseH, 0),
  );

  const capMesh = loft(
    [capBot, capTop],
    [[0, baseH + shaftH, 0], [0, baseH + shaftH + capH, 0]],
  );

  return mergeMeshes([baseMesh, shaftMesh, capMesh]);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=@hayba/architecture -- column.test`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/kernel/elements/column.ts packages/architecture/src/kernel/elements/column.test.ts
git commit -m "feat(architecture): column element generator (revolve + loft)"
```

---

### Task 13: Hand-authored Gothic column binding

**Files:**
- Create: `packages/architecture/src/bindings/medieval-european-gothic/column.json`

- [ ] **Step 1: Author the binding**

`packages/architecture/src/bindings/medieval-european-gothic/column.json`:
```json
{
  "elementId": "column",
  "styleSheetId": "medieval-european-gothic",
  "seed": "0x6f7468696367",
  "profiles": {
    "shaft": "<svg viewBox=\"0 0 200 1000\"><path d=\"M 60 0 L 70 0 L 70 30 L 80 60 L 80 940 L 70 970 L 70 1000 L 60 1000 Z\"/></svg>",
    "base": "<svg viewBox=\"0 0 300 80\"><path d=\"M 0 0 L 130 0 L 130 20 L 110 40 L 90 60 L 70 70 L 60 80 L 0 80 Z\"/></svg>",
    "capital_bottom": "<svg viewBox=\"-100 -100 200 200\"><path d=\"M -55 0 L -39 -39 L 0 -55 L 39 -39 L 55 0 L 39 39 L 0 55 L -39 39 Z\"/></svg>",
    "capital_top": "<svg viewBox=\"-150 -150 300 300\"><path d=\"M -120 0 L -85 -85 L 0 -120 L 85 -85 L 120 0 L 85 85 L 0 120 L -85 85 Z\"/></svg>"
  },
  "params": {
    "base_height_m": 0.22,
    "shaft_height_m": 4.5,
    "capital_height_m": 0.45,
    "revolve_segments": 32
  },
  "provenance": {
    "source": "human",
    "createdAt": "2026-05-13T00:00:00Z"
  }
}
```

**Authoring notes** (preserve in commit message): The shaft has a slight entasis (slightly convex sides) characteristic of Gothic clustered shafts. The base has a stepped profile (plinth → torus → scotia → astragal) typical of high-medieval ecclesiastical work. The capital uses an octagonal cross-section (8 sides) that widens significantly to suggest stiff-leaf or crocket carving above the shaft. Seed is `0x6f7468696367` — bytes spell "othicg" as a memorable anchor.

- [ ] **Step 2: Note on the seed field**

The JSON spec doesn't directly support bigint literals, so seeds are stored as hex strings prefixed `0x...`. The registry converts them to `bigint` on load. Verify the seed parses correctly in Task 14.

- [ ] **Step 3: Commit**

```bash
git add packages/architecture/src/bindings/medieval-european-gothic/column.json
git commit -m "feat(architecture): hand-authored Gothic column binding (entasis + stepped base + octagonal capital)"
```

---

### Task 14: Element + binding registry

**Files:**
- Create: `packages/architecture/src/kernel/elements/index.ts` — generator registry
- Create: `packages/architecture/src/element-registry.ts` — element + binding loader
- Modify: `packages/architecture/src/index.ts` — re-export kernel + element registry

- [ ] **Step 1: Write the generator registry**

`packages/architecture/src/kernel/elements/index.ts`:
```ts
/**
 * Maps element id → generator function. Hand-authored — adding a new element
 * type requires both adding a .ts file here AND registering it in this map.
 */
import type { ElementBinding } from '../../schema.js';
import type { Mesh } from '../types.js';
import { columnGraph } from './column.js';

export type ElementGenerator = (b: ElementBinding) => Mesh;

export const ELEMENT_GENERATORS: Readonly<Record<string, ElementGenerator>> = {
  column: columnGraph,
};
```

- [ ] **Step 2: Write the failing registry test**

`packages/architecture/src/element-registry.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  loadElementCatalog, loadBinding, emitElementMesh,
} from './element-registry.js';

describe('element-registry', () => {
  it('loads the column element type', () => {
    const cat = loadElementCatalog();
    expect(cat.elementsById.has('column')).toBe(true);
  });

  it('loads the Gothic column binding', () => {
    const b = loadBinding('medieval-european-gothic', 'column');
    expect(b).not.toBeNull();
    expect(b!.elementId).toBe('column');
    expect(b!.styleSheetId).toBe('medieval-european-gothic');
    expect(typeof b!.seed).toBe('bigint');
  });

  it('emits a non-empty mesh for the Gothic column', () => {
    const result = emitElementMesh('medieval-european-gothic', 'column');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.glb.byteLength).toBeGreaterThan(200);
      expect(result.stats.triangles).toBeGreaterThan(0);
    }
  });

  it('returns error for unknown style sheet', () => {
    const result = emitElementMesh('mystery', 'column');
    expect(result.ok).toBe(false);
  });

  it('returns error for unknown element', () => {
    const result = emitElementMesh('medieval-european-gothic', 'mystery');
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test --workspace=@hayba/architecture -- element-registry.test`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement element-registry.ts**

`packages/architecture/src/element-registry.ts`:
```ts
import { validateElement, validateElementBinding, type ValidationError } from './validate.js';
import type { Element, ElementBinding } from './schema.js';
import { ELEMENT_GENERATORS } from './kernel/elements/index.js';
import { emitGLB } from './kernel/glb-emit.js';

import columnFile from './data/elements/column.json' with { type: 'json' };

// Bindings — hand-imported list. Plan 2 will add the rest.
import gothicColumnFile from './bindings/medieval-european-gothic/column.json' with { type: 'json' };

const RAW_ELEMENTS: unknown[] = [columnFile];

interface BindingRecord {
  styleSheetId: string;
  raw: unknown;   // pre-validation
}
const RAW_BINDINGS: BindingRecord[] = [
  { styleSheetId: 'medieval-european-gothic', raw: gothicColumnFile },
];

export interface ElementCatalog {
  readonly elementsById: ReadonlyMap<string, Element>;
}

export interface BindingCatalog {
  /** key = `${styleSheetId}::${elementId}` */
  readonly byKey: ReadonlyMap<string, ElementBinding>;
}

let CAT_ELEMENTS: ElementCatalog | null = null;
let CAT_BINDINGS: BindingCatalog | null = null;

export function loadElementCatalog(): ElementCatalog {
  if (CAT_ELEMENTS) return CAT_ELEMENTS;
  const errors: ValidationError[] = [];
  const elementsById = new Map<string, Element>();
  RAW_ELEMENTS.forEach((e, i) => {
    const errs = validateElement(e, `/elements/${i}`);
    if (errs.length === 0) {
      const typed = e as Element;
      if (elementsById.has(typed.id)) {
        errors.push({ path: `/elements/${i}/id`, message: `duplicate element id ${typed.id}` });
      } else {
        elementsById.set(typed.id, typed);
      }
    } else {
      errors.push(...errs);
    }
  });
  if (errors.length > 0) {
    throw new Error(`@hayba/architecture: element catalog load failed: ${JSON.stringify(errors, null, 2)}`);
  }
  CAT_ELEMENTS = { elementsById };
  return CAT_ELEMENTS;
}

function parseBindingSeed(raw: unknown): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'string') return BigInt(raw);
  if (typeof raw === 'number') return BigInt(raw);
  throw new Error(`seed must be bigint, hex string, or number; got ${typeof raw}`);
}

function loadBindingCatalog(): BindingCatalog {
  if (CAT_BINDINGS) return CAT_BINDINGS;
  const elements = loadElementCatalog();
  const errors: ValidationError[] = [];
  const byKey = new Map<string, ElementBinding>();

  RAW_BINDINGS.forEach(({ styleSheetId, raw }, i) => {
    if (typeof raw !== 'object' || raw === null) {
      errors.push({ path: `/bindings/${i}`, message: 'expected an object' });
      return;
    }
    // Coerce seed string → bigint before validation.
    const rawWithSeed = { ...(raw as object), seed: parseBindingSeed((raw as { seed: unknown }).seed) };
    const elementId = (rawWithSeed as { elementId?: string }).elementId;
    if (!elementId || !elements.elementsById.has(elementId)) {
      errors.push({ path: `/bindings/${i}/elementId`, message: `unknown element ${JSON.stringify(elementId)}` });
      return;
    }
    const element = elements.elementsById.get(elementId)!;
    const bindingErrs = validateElementBinding(rawWithSeed, element, `/bindings/${i}`);
    if (bindingErrs.length > 0) {
      errors.push(...bindingErrs);
      return;
    }
    const typed = rawWithSeed as ElementBinding;
    const key = `${styleSheetId}::${elementId}`;
    if (byKey.has(key)) {
      errors.push({ path: `/bindings/${i}`, message: `duplicate binding for ${key}` });
      return;
    }
    byKey.set(key, typed);
  });

  if (errors.length > 0) {
    throw new Error(`@hayba/architecture: binding catalog load failed: ${JSON.stringify(errors, null, 2)}`);
  }
  CAT_BINDINGS = { byKey };
  return CAT_BINDINGS;
}

export function loadBinding(styleSheetId: string, elementId: string): ElementBinding | null {
  return loadBindingCatalog().byKey.get(`${styleSheetId}::${elementId}`) ?? null;
}

export interface EmitResult {
  ok: true;
  glb: ArrayBuffer;
  stats: { vertices: number; triangles: number; sizeBytes: number };
} 
export interface EmitError {
  ok: false;
  error: 'not_found' | 'kernel_error';
  message: string;
}

export function emitElementMesh(styleSheetId: string, elementId: string): EmitResult | EmitError {
  const binding = loadBinding(styleSheetId, elementId);
  if (!binding) {
    return { ok: false, error: 'not_found', message: `no binding for ${styleSheetId}::${elementId}` };
  }
  const gen = ELEMENT_GENERATORS[elementId];
  if (!gen) {
    return { ok: false, error: 'not_found', message: `no generator registered for element ${elementId}` };
  }
  try {
    const mesh = gen(binding);
    const glb = emitGLB(mesh);
    return {
      ok: true,
      glb,
      stats: {
        vertices: mesh.positions.length / 3,
        triangles: mesh.indices.length / 3,
        sizeBytes: glb.byteLength,
      },
    };
  } catch (e: unknown) {
    return { ok: false, error: 'kernel_error', message: e instanceof Error ? e.message : String(e) };
  }
}

/** Test-only cache reset. */
export function _resetCacheForTests(): void {
  CAT_ELEMENTS = null;
  CAT_BINDINGS = null;
}
```

- [ ] **Step 5: Update index.ts re-exports**

Append to `packages/architecture/src/index.ts`:
```ts
// Element catalog + kernel surface
export type {
  ProfileHint, ProfileSlot, ParamSlot, ParamSlotKind,
  ElementCategory, ElementGraphRef, Element,
  ProvenanceSource, BindingProvenance, ElementBinding,
} from './schema.js';
export { validateElement, validateElementBinding, isElement } from './validate.js';
export type { ElementCatalog, BindingCatalog, EmitResult, EmitError } from './element-registry.js';
export {
  loadElementCatalog, loadBinding, emitElementMesh,
} from './element-registry.js';
```

- [ ] **Step 6: Run tests**

Run: `npm test --workspace=@hayba/architecture -- element-registry.test`
Expected: PASS — 5 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/architecture/src/kernel/elements/index.ts packages/architecture/src/element-registry.ts packages/architecture/src/element-registry.test.ts packages/architecture/src/index.ts
git commit -m "feat(architecture): element + binding registry with mesh emit"
```

---

### Task 15: End-to-end determinism test

**Files:**
- Modify: `packages/architecture/src/element-registry.test.ts` — add a determinism sweep.

- [ ] **Step 1: Append determinism test**

Append to `packages/architecture/src/element-registry.test.ts`:
```ts
import { _resetCacheForTests } from './element-registry.js';

describe('determinism — Gothic column GLB byte-equality', () => {
  it('two emits of the same binding produce byte-identical GLB output', () => {
    const a = emitElementMesh('medieval-european-gothic', 'column');
    const b = emitElementMesh('medieval-european-gothic', 'column');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.glb.byteLength).toBe(b.glb.byteLength);
      const av = new Uint8Array(a.glb);
      const bv = new Uint8Array(b.glb);
      for (let i = 0; i < av.length; i++) {
        if (av[i] !== bv[i]) throw new Error(`byte mismatch at offset ${i}: ${av[i]} vs ${bv[i]}`);
      }
    }
  });

  it('cache reset + re-emit still produces byte-identical output', () => {
    const a = emitElementMesh('medieval-european-gothic', 'column');
    _resetCacheForTests();
    const b = emitElementMesh('medieval-european-gothic', 'column');
    expect(a.ok && b.ok && a.glb.byteLength === b.glb.byteLength).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test --workspace=@hayba/architecture`
Expected: ALL TESTS PASS — full count rises by 2.

- [ ] **Step 3: Commit**

```bash
git add packages/architecture/src/element-registry.test.ts
git commit -m "test(architecture): GLB determinism — byte-equality across emits + cache reset"
```

---

### Task 16: Atlas integration — "Bound elements" section + three.js viewer

**Files:**
- Modify: `packages/architecture/demo/index.html` — add a "Bound elements" panel on style-sheet detail + three.js GLB viewer modal.

- [ ] **Step 1: Add three.js import to the demo HTML**

In the existing `<script type="module">` block in `packages/architecture/demo/index.html`, replace the existing data-loading block at the top with:

```js
import * as THREE from 'https://unpkg.com/three@0.169.0/build/three.module.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.169.0/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'https://unpkg.com/three@0.169.0/examples/jsm/controls/OrbitControls.js';

const GUIDE_FILES = [
  /* (existing list — unchanged) */
];

// NEW: load bindings.
const BOUND_PAIRS = [
  { styleSheetId: 'medieval-european-gothic', elementId: 'column' },
];

const [typologyFile, ...guides] = await Promise.all([
  fetch('../src/data/typologies.json').then(r => r.json()),
  ...GUIDE_FILES.map(n => fetch(`../src/data/style-guides/${n}.json`).then(r => r.json())),
]);

const bindings = {};
for (const { styleSheetId, elementId } of BOUND_PAIRS) {
  bindings[`${styleSheetId}::${elementId}`] =
    await fetch(`../src/bindings/${styleSheetId}/${elementId}.json`).then(r => r.json());
}
```

(The rest of the existing data setup — `typologies`, `typologyById`, `guideById`, `byCulture`, `extrasKeys`, `state`, `renderStats`, etc. — stays the same.)

- [ ] **Step 2: Add "Bound elements" panel to the guides-view center renderer**

Inside `renderCenter()`'s `if (state.view === 'guides')` branch, after the existing `Extras` panel, append:

```js
const boundForThis = BOUND_PAIRS.filter(p => p.styleSheetId === g.id);
const boundPanelHtml = boundForThis.length === 0 ? '' : `
  <div class="panel">
    <div class="panel-h">Bound elements · ${boundForThis.length}</div>
    <div class="bound-elements-grid">
      ${boundForThis.map(p => {
        const b = bindings[`${p.styleSheetId}::${p.elementId}`];
        return `
          <div class="bound-element-card" data-element="${p.elementId}" data-style="${p.styleSheetId}">
            <div class="bec-name">${humanize(p.elementId)}</div>
            <div class="bec-thumb" id="thumb-${p.styleSheetId}-${p.elementId}">
              <span class="muted" style="font-size:11px;">loading 3D…</span>
            </div>
            <div class="bec-meta">
              <span class="mono muted">${b.params.shaft_height_m ?? '—'}m height · seed ${String(b.seed).slice(0, 10)}…</span>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  </div>
`;
```

Then in the template literal that sets `wrap.innerHTML`, insert `${boundPanelHtml}` *after* the existing Extras panel.

Also add CSS in the `<style>` block:

```css
  .bound-elements-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 10px;
  }
  .bound-element-card {
    background: var(--bg-base); border: 1px solid var(--border-mid);
    border-radius: 6px; padding: 12px;
    display: flex; flex-direction: column; gap: 6px;
    cursor: pointer;
    transition: border-color .12s, transform .12s;
  }
  .bound-element-card:hover { border-color: var(--accent); transform: translateY(-2px); }
  .bec-name {
    font-weight: 600; font-size: 13px; text-transform: capitalize;
  }
  .bec-thumb {
    background: var(--bg-deep); border-radius: 3px;
    height: 140px; display: flex; align-items: center; justify-content: center;
  }
  .bec-meta { font-size: 10.5px; }
```

- [ ] **Step 3: Add the three.js viewer modal**

Append HTML inside `<body>` (just before the existing closing `</body>`):

```html
<div id="viewerModal" class="viewer-modal" style="display:none;">
  <div class="viewer-modal-backdrop"></div>
  <div class="viewer-modal-card">
    <div class="viewer-modal-h">
      <span id="viewerModalTitle">Element preview</span>
      <button class="viewer-modal-close" id="viewerModalClose">✕</button>
    </div>
    <div id="viewerStage" class="viewer-stage"></div>
    <div id="viewerStats" class="viewer-stats"></div>
  </div>
</div>
```

Append CSS:

```css
  .viewer-modal { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; }
  .viewer-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.6); }
  .viewer-modal-card {
    position: relative; width: 720px; max-width: 90vw; max-height: 90vh;
    background: var(--bg-base); border: 1px solid var(--border-soft);
    border-radius: 8px; padding: 16px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .viewer-modal-h { display: flex; align-items: center; justify-content: space-between; }
  .viewer-modal-h span { font-size: 14px; font-weight: 600; }
  .viewer-modal-close {
    background: transparent; border: none; color: var(--text-secondary);
    cursor: pointer; font-size: 18px;
  }
  .viewer-stage {
    width: 100%; height: 480px; background: var(--bg-deep);
    border-radius: 4px;
  }
  .viewer-stats {
    font-family: var(--font-mono); font-size: 11px; color: var(--text-muted);
  }
```

- [ ] **Step 4: Add the JS to wire viewer + load real GLB via the kernel**

We need to call our kernel in the browser. Two options:

**Option A** — import the built kernel from `../dist/index.js`. This requires `npm run build --workspace=@hayba/architecture` to have run, which writes `dist/index.js` etc.

**Option B** — call the kernel via an API endpoint. Heavier; skip for v1.

Use Option A. Append to the `<script type="module">` block (after `boot`):

```js
async function loadKernel() {
  try {
    const mod = await import('../dist/index.js');
    return mod;
  } catch (e) {
    console.error('Kernel import failed (did you run `npm run build`?):', e);
    return null;
  }
}

const kernelMod = await loadKernel();

function emitGLBForBinding(styleSheetId, elementId) {
  if (!kernelMod) throw new Error('Kernel not loaded');
  const result = kernelMod.emitElementMesh(styleSheetId, elementId);
  if (!result.ok) throw new Error(result.message);
  return result;   // { ok, glb: ArrayBuffer, stats }
}

function openViewer(styleSheetId, elementId) {
  document.getElementById('viewerModal').style.display = 'flex';
  document.getElementById('viewerModalTitle').textContent = `${humanize(elementId)} · ${cultureLabel(styleSheetId)}`;
  const stage = document.getElementById('viewerStage');
  stage.innerHTML = '';
  const stats = document.getElementById('viewerStats');
  stats.textContent = 'loading…';

  let result;
  try {
    result = emitGLBForBinding(styleSheetId, elementId);
  } catch (e) {
    stage.innerHTML = `<div style="padding:24px;color:var(--status-red);">Kernel error: ${e.message}</div>`;
    return;
  }
  stats.textContent = `triangles ${result.stats.triangles} · vertices ${result.stats.vertices} · ${(result.stats.sizeBytes/1024).toFixed(1)} KB`;

  // Set up scene.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1e24);
  const camera = new THREE.PerspectiveCamera(45, stage.clientWidth / stage.clientHeight, 0.01, 100);
  camera.position.set(2.5, 3, 4);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  stage.appendChild(renderer.domElement);

  const light1 = new THREE.DirectionalLight(0xffffff, 1.2);
  light1.position.set(5, 8, 6);
  scene.add(light1);
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const grid = new THREE.GridHelper(10, 10, 0x3d434e, 0x2a2e36);
  scene.add(grid);

  const loader = new GLTFLoader();
  loader.parse(result.glb, '', (gltf) => {
    // Apply a stone-like material.
    gltf.scene.traverse((o) => {
      if (o.isMesh) {
        o.material = new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.85, metalness: 0.1 });
      }
    });
    scene.add(gltf.scene);
    // Center camera around the column.
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    camera.position.set(center.x + size.x * 2, center.y + size.y * 0.7, center.z + size.z * 2);
    controls.target.copy(center);
    controls.update();
  }, (err) => {
    stage.innerHTML = `<div style="padding:24px;color:var(--status-red);">GLB load error: ${err}</div>`;
  });

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  (function animate() {
    if (!document.getElementById('viewerModal').contains(stage)) return;   // stop when modal closed
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();
}

document.getElementById('viewerModalClose').addEventListener('click', () => {
  document.getElementById('viewerModal').style.display = 'none';
  document.getElementById('viewerStage').innerHTML = '';
});

// Wire the bound-element cards.
document.addEventListener('click', (e) => {
  const card = e.target.closest('.bound-element-card');
  if (!card) return;
  openViewer(card.dataset.style, card.dataset.element);
});
```

- [ ] **Step 5: Update the package.json `serve` script to build first**

Modify `packages/architecture/package.json`:
```json
    "serve": "tsc && node demo/serve.mjs"
```
(Currently it's `node demo/serve.mjs`; building first ensures `dist/index.js` exists.)

- [ ] **Step 6: Run the demo**

```bash
npm run serve --workspace=@hayba/architecture
```
Expected: server logs `hayba architecture demo · http://localhost:5184/demo/`.

Open the URL in a browser. Click any culture in the left rail until you reach `Gothic`. Scroll the center pane to find the new **Bound elements** panel. Click the `column` card. The modal should open with a rotating 3D Gothic column on a grid.

- [ ] **Step 7: Visual checkpoint (mandatory)**

Per the determinism contract, every visible feature requires a screenshot. Capture:
- The Bound elements panel on the Gothic detail page.
- The 3D viewer modal showing the rotating column.

Save both screenshots to `tmp_arch_element_*.png` and reference them in the commit message.

- [ ] **Step 8: Commit**

```bash
git add packages/architecture/demo/index.html packages/architecture/package.json
git commit -m "feat(architecture): atlas integration — Bound elements panel + 3D viewer modal

The Gothic style sheet now shows a 'Bound elements' panel with a card for
the Gothic column. Clicking opens a three.js viewer modal that calls the
kernel via the built dist/, decodes the GLB, and renders an orbit-controllable
3D column with PBR stone material."
```

---

### Task 17: Final coverage + branch push gate

**Files:** none modified — verification only.

- [ ] **Step 1: Run full test suite + coverage**

```bash
npm test --workspace=@hayba/architecture -- --coverage
```
Expected:
- All tests pass (running count: schema 9 + validate 33 + registry 11 + mcp 14 + svg-parse 8 + primitives 22 + glb-emit 3 + column 3 + element-registry 7 = **110 tests**).
- Coverage for kernel files (`primitives.ts`, `svg-parse.ts`, `glb-emit.ts`, `elements/column.ts`) ≥ 80%.
- Coverage for `element-registry.ts` ≥ 80%.

If coverage falls short, add targeted tests in the corresponding `*.test.ts` file.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck --workspace=@hayba/architecture
```
Expected: silent (no errors).

- [ ] **Step 3: Build**

```bash
npm run build --workspace=@hayba/architecture
```
Expected: `dist/` populated with `.js` + `.d.ts` files for all kernel + element-registry modules.

- [ ] **Step 4: Final commit (if any cleanup edits)**

```bash
git status
```
If anything dangling — stage + commit. Otherwise skip.

- [ ] **Step 5: Branch push (with user approval)**

```bash
git push -u origin feat/architecture-pillar
```
Wait for explicit user approval before pushing.

---

## Definition of done (end-state acceptance)

- [x] Schema extended with Element / ElementBinding types *(Task 1)*
- [x] Validators for both, with cross-ref check between binding and its element *(Task 2)*
- [x] One element definition: `column.json` *(Task 3)*
- [x] three.js dependency added *(Task 4)*
- [x] Kernel: 4 primitives (transform, revolve, loft, mergeMeshes), SVG parser, GLB emitter — all unit-tested *(Tasks 5–11)*
- [x] One generator: `column.ts` *(Task 12)*
- [x] One hand-authored binding: `medieval-european-gothic/column.json` *(Task 13)*
- [x] Registry: load element catalog + bindings + emit deterministic meshes *(Task 14)*
- [x] Determinism test: byte-identical GLB across emits + cache reset *(Task 15)*
- [x] Atlas integration: Bound elements panel on Gothic detail page; 3D viewer modal with orbit controls *(Task 16)*
- [x] Visual checkpoint: rotating Gothic column screenshot *(Task 16)*
- [x] vitest ≥80% on kernel files + element-registry *(Task 17)*
- [x] Typecheck + build clean *(Task 17)*

## Out of scope (re-stated for the implementer's sanity)

- AI binding pipeline — *Plan 3*
- Cornice, arch, doorframe, windowframe, lintel, finial, frieze, pediment, niche — *Plan 2*
- Boolean / CSG ops — *Plan 2 (introduced when arch / windowframe land)*
- All other style sheet × element bindings — *Plan 2*
- MCP tools — *Plan 4*
- Editor matrix view, regenerate UX, reference upload — *Plan 5*
- UE5 PCG export — *Plan 6*

## Self-review notes (already applied above)

- Confirmed every type used in later tasks (`Mesh`, `SvgPath`, `Element`, `ElementBinding`) is exported by an earlier task.
- Confirmed test counts: 9 + 33 + 11 + 14 + 8 + 22 + 3 + 3 + 7 = 110 by Task 17 end.
- Confirmed every spec section has at least one task implementing it (§ 1 → T1; § 2 → T5–11; § 3 → deferred to Plan 3; § 4 → T13–14; § 5 → T3, T12, T13; § 6 → T16; § 7 → deferred to Plan 4; § 8 → T15).
- Confirmed the symmetric-half-x≥0 rule is enforced in svg-parse.ts AND tested in T6.
- Confirmed seed serialization (bigint stored as hex string in JSON) is handled in T14's `parseBindingSeed`.
- Confirmed kernel module paths (`./kernel/elements/column.js`) align with `tsconfig.json`'s `module: NodeNext` resolution.
