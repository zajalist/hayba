# Semantic Studio — Plan A: TS Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure-TS foundation the Semantic Studio compiles against — the 11th primitive (`surface_contact`), the mask data model, mask-referencing in primitives, the constraint-graph compile, and the mask MCP tools — all unit-tested, no UE rebuild required.

**Architecture:** Extends the shipped `src/plumb/` subsystem. Masks become first-class on `Profile`; mask-referencing primitives resolve a region from the profile by mask id; a constraint graph (nodes+edges) compiles down to the existing `Constraint[]` the shipped evaluator already runs. The UE window (Plan B) is a pure consumer of these TS artifacts.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Zod, the MCP server tool registry.

## Global Constraints

- Module system: ESM — every relative import ends in `.js` (e.g. `from './contracts.js'`).
- Tests: Vitest, colocated as `*.test.ts`; run with `npx vitest run <path>`.
- The closed primitive set may grow ONLY by adding to `PRIMITIVES` in `src/plumb/primitives.ts` — no operators, no expression nodes, no branching. Authoring fills values only.
- Stores are JSON under `.scratch/`, env-overridable (`HAYBA_PROFILES`, `HAYBA_CONSTRAINTS`); never hardcode absolute paths.
- New MCP tools are `plumb_`-prefixed, registered in `src/tools/index.ts`, added to `ALWAYS_ON_META` + `passthrough(...)` in `src/tools/routing/register.ts`, and `reg(...)`-seeded in `recordEagerSchemas`.
- Commit messages: no `Co-Authored-By: Claude` trailer.
- `GateName` enum stays `collision | stability | constraints | reach`; `reach` is reserved and always emitted skipped.

---

### Task 1: `surface_contact` primitive (#11)

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/plumb/primitives.ts` (append to `PRIMITIVES`)
- Test: `mcp-tools/hayba-mcp/src/plumb/plumb.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `Primitive`, `PrimitiveContext`, `matchFilter`, `SKIP`, vector helpers in `primitives.ts`.
- Produces: a `PRIMITIVES` entry with `id: 'surface_contact'`, `gate: 'stability'`, `defaultHard: true`, `qualitative: false`, `params: ['max_gap_m', 'asset', 'tag_axis', 'tag_value']`. Inverse of `clearance`: passes when a surface is *within* `max_gap_m`.

- [ ] **Step 1: Write the failing test**

```ts
describe('surface_contact primitive', () => {
  const prim = primitivesById().get('surface_contact')!;
  it('passes when a surface is within the gap and fails when too far', () => {
    const a = inst('door', [0, 0, 0]);
    const near = inst('wall', [0.05, 0, 0]);
    const far = inst('wall', [3, 0, 0]);
    const pass = prim.evaluate({ constraint: { id: 's', primitive: 'surface_contact', params: { max_gap_m: 0.1 }, binding: { asset: 'x' } }, instance: a, profile: null, scene: { instances: [a, near] } });
    expect(pass.value_m).toBeGreaterThanOrEqual(0);
    const fail = prim.evaluate({ constraint: { id: 's', primitive: 'surface_contact', params: { max_gap_m: 0.1 }, binding: { asset: 'x' } }, instance: a, profile: null, scene: { instances: [a, far] } });
    expect(fail.value_m).toBeLessThan(0);
    expect(fail.fix!.translate[0]).toBeGreaterThan(0); // pulled toward the wall (+x)
  });
  it('skips when no candidate surfaces match', () => {
    const a = inst('door', [0, 0, 0]);
    const out = prim.evaluate({ constraint: { id: 's', primitive: 'surface_contact', params: {}, binding: { asset: 'x' } }, instance: a, profile: null, scene: { instances: [a] } });
    expect(out.skip).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plumb/plumb.test.ts -t surface_contact`
Expected: FAIL — `primitivesById().get('surface_contact')` is `undefined`.

- [ ] **Step 3: Append the primitive to `PRIMITIVES`** (after `affordance_clear`)

```ts
  {
    id: 'surface_contact',
    gate: 'stability',
    defaultHard: true,
    qualitative: false,
    doc: 'Inverse of clearance: a glue surface must sit WITHIN max_gap_m of another surface (proper anchoring, e.g. a door against a wall). Centre-to-centre proxy until a scene-time surface trace is wired (UE).',
    params: ['max_gap_m', 'asset', 'tag_axis', 'tag_value'],
    evaluate: ({ constraint, instance, scene }) => {
      const gap = num(constraint.params.max_gap_m, 0.1);
      const others = matchFilter(scene, instance.object, {
        asset: str(constraint.params.asset),
        axis: str(constraint.params.tag_axis),
        value: str(constraint.params.tag_value),
      });
      if (others.length === 0) return SKIP('no candidate surfaces match filter');
      let nearest = others[0], best = Infinity;
      for (const o of others) {
        const d = dist(instance.transform.pos, o.transform.pos);
        if (d < best) { best = d; nearest = o; }
      }
      const value_m = gap - best;          // >=0 when within the gap (in contact)
      let fix: FixVector | undefined;
      if (value_m < 0) {
        const toward = norm(sub(nearest.transform.pos, instance.transform.pos));
        const pull = -value_m;
        fix = { translate: [toward[0] * pull, toward[1] * pull, toward[2] * pull] };
      }
      return { value_m, fix, detail: `nearest surface ${best.toFixed(2)}m vs gap ${gap}m` };
    },
  },
```

- [ ] **Step 4: Update the closed-set count test** in `plumb.test.ts`

Change `expect(PRIMITIVES.length).toBe(10)` → `toBe(11)` and the unique-ids `toBe(10)` → `toBe(11)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/plumb/plumb.test.ts`
Expected: PASS (all, including the updated count test).

- [ ] **Step 6: Commit**

```bash
git add mcp-tools/hayba-mcp/src/plumb/primitives.ts mcp-tools/hayba-mcp/src/plumb/plumb.test.ts
git commit -m "feat(plumb): surface_contact primitive (#11) for glue-to-wall anchoring"
```

---

### Task 2: Mask data model on `Profile`

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/plumb/contracts.ts` (add `Mask`, `Profile.masks`)
- Modify: `mcp-tools/hayba-mcp/src/plumb/profile-store.ts` (add `addMask`, `removeMask`, `getMask`)
- Modify: `mcp-tools/hayba-mcp/src/plumb/index.ts` (re-export)
- Test: `mcp-tools/hayba-mcp/src/plumb/plumb.test.ts` (mask store cases)

**Interfaces:**
- Produces:
  - `Mask` type (see Step 3).
  - `Profile.masks?: Mask[]`.
  - `addMask(assetId: string, mask: Mask): Profile | null` (null if no base profile; upserts by mask.id).
  - `removeMask(assetId: string, maskId: string): boolean`.
  - `getMask(assetId: string, maskId: string): Mask | null`.

- [ ] **Step 1: Write the failing test**

```ts
describe('mask store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mask-')); setProfilesPath(join(dir, 'p.json')); putProfile(bakeProfile({ asset_id: '/Game/Door', origin_cm: [0,0,0], extent_cm: [50,10,100] }, 'now')); });
  afterEach(() => { setProfilesPath(null); rmSync(dir, { recursive: true, force: true }); });

  it('adds, gets and removes a volume mask', () => {
    const m = { id: 'swing_front', type: 'volume' as const, color: '#48f', source: 'ai' as const, confidence: 0.8, locked: false, shape: { kind: 'box' as const, transform: identityTransform(), extents: [1,1,2] as [number,number,number] } };
    expect(addMask('/Game/Door', m)!.masks!.length).toBe(1);
    expect(getMask('/Game/Door', 'swing_front')!.type).toBe('volume');
    expect(removeMask('/Game/Door', 'swing_front')).toBe(true);
    expect(getMask('/Game/Door', 'swing_front')).toBe(null);
  });
  it('addMask returns null with no base profile', () => {
    expect(addMask('/Game/Nope', { id: 'x', type: 'surface', color: '#fff', source: 'human', confidence: 1, locked: false, triangles: [1,2,3] })).toBe(null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plumb/plumb.test.ts -t "mask store"`
Expected: FAIL — `addMask` is not exported.

- [ ] **Step 3: Add the `Mask` type to `contracts.ts`** (after `Affordance`) and extend `Profile`

```ts
export interface Mask {
  id: string;
  type: 'surface' | 'volume';
  color: string;            // overlay color, '#RRGGBB'
  source: 'ai' | 'human';
  confidence: number;       // 0..1
  locked: boolean;          // gates whether qualitative primitives may hard-gate
  triangles?: number[];     // surface: mesh triangle indices (deterministic v1)
  shape?: {                 // volume:
    kind: 'box' | 'sphere' | 'capsule' | 'convex';
    transform: Transform;
    extents?: [number, number, number];
    radius?: number;
    points?: [number, number, number][];
  };
  detail?: string;          // free-text semantic note
}
```

Add to the `Profile` interface: `masks?: Mask[];`

- [ ] **Step 4: Add store helpers to `profile-store.ts`**

```ts
export function getMask(assetId: string, maskId: string): Mask | null {
  const p = getProfile(assetId);
  return p?.masks?.find(m => m.id === maskId) ?? null;
}

export function addMask(assetId: string, mask: Mask): Profile | null {
  const all = readAll();
  const base = all[assetId];
  if (!base) return null;
  const masks = (base.masks ?? []).filter(m => m.id !== mask.id);
  masks.push(mask);
  const merged: Profile = { ...base, masks };
  all[assetId] = merged;
  writeAll(all);
  return merged;
}

export function removeMask(assetId: string, maskId: string): boolean {
  const all = readAll();
  const base = all[assetId];
  if (!base?.masks) return false;
  const next = base.masks.filter(m => m.id !== maskId);
  if (next.length === base.masks.length) return false;
  all[assetId] = { ...base, masks: next };
  writeAll(all);
  return true;
}
```

Add `import type { ..., Mask } from './contracts.js';` to the existing type import.

- [ ] **Step 5: Re-export from `index.ts`**

Add `Mask` to the `export type { ... } from './contracts.js'` list and `getMask, addMask, removeMask` to the profile-store export.

- [ ] **Step 6: Run tests + tsc**

Run: `npx vitest run src/plumb/plumb.test.ts -t "mask store"` → PASS
Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors

- [ ] **Step 7: Commit**

```bash
git add mcp-tools/hayba-mcp/src/plumb/contracts.ts mcp-tools/hayba-mcp/src/plumb/profile-store.ts mcp-tools/hayba-mcp/src/plumb/index.ts mcp-tools/hayba-mcp/src/plumb/plumb.test.ts
git commit -m "feat(plumb): mask data model on Profile + store helpers"
```

---

### Task 3: Mask-referencing in primitives (resolve a region by mask id)

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/plumb/primitives.ts` (mask-region resolution for `inside_outside`, `clearance`, `affordance_clear`)
- Test: `mcp-tools/hayba-mcp/src/plumb/plumb.test.ts`

**Interfaces:**
- Produces: mask-referencing primitives accept a `mask` param (a mask id on the instance's profile). When present, the primitive resolves the mask's world-space region from `ctx.profile.masks` and uses it instead of inline `center/extents`. `inside_outside` and `affordance_clear` consume volume/surface masks; behavior is unchanged when `mask` is absent (back-compat).

- [ ] **Step 1: Write the failing test**

```ts
describe('mask-referencing primitives', () => {
  it('inside_outside resolves a volume mask region from the profile', () => {
    let profile = bakeProfile({ asset_id: '/Game/Zone', origin_cm: [0,0,0], extent_cm: [10,10,10] }, 'now');
    profile = { ...profile, masks: [{ id: 'keep_in', type: 'volume', color: '#0f0', source: 'human', confidence: 1, locked: true, shape: { kind: 'box', transform: { pos: [0,0,0], quat: [0,0,0,1], scale: [1,1,1] }, extents: [2,2,2] } }] };
    const prim = primitivesById().get('inside_outside')!;
    const inside = prim.evaluate({ constraint: { id: 'c', primitive: 'inside_outside', params: { mask: 'keep_in', mode: 'inside' }, binding: { asset: '/Game/Zone' } }, instance: { object: 'p', asset: '/Game/Zone', transform: { pos: [0,0,0], quat: [0,0,0,1], scale: [1,1,1] } }, profile, scene: { instances: [] } });
    expect(inside.value_m).toBeGreaterThan(0);   // at centre, inside the 2m box
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plumb/plumb.test.ts -t "mask-referencing"`
Expected: FAIL — `inside_outside` ignores `mask`, reads default `[1,1,1]` extents, so the margin differs from the 2m box.

- [ ] **Step 3: Add a mask-region resolver near the top of `primitives.ts`**

```ts
/** Resolve an axis-aligned region {center,extents} (metres, world) from a mask
 *  on the instance's profile. Returns null when the mask/shape is absent. */
function maskRegion(profile: Profile | null, maskId: string | undefined, inst: InstanceState): { center: V3; extents: V3 } | null {
  if (!maskId) return null;
  const m = profile?.masks?.find(x => x.id === maskId);
  if (!m) return null;
  if (m.type === 'volume' && m.shape) {
    const t = m.shape.transform;
    const ext = m.shape.extents ?? [m.shape.radius ?? 0.5, m.shape.radius ?? 0.5, m.shape.radius ?? 0.5];
    return {
      center: [inst.transform.pos[0] + t.pos[0], inst.transform.pos[1] + t.pos[1], inst.transform.pos[2] + t.pos[2]],
      extents: ext as V3,
    };
  }
  return null; // surface masks are handled by surface_contact / affordance_clear paths
}
```

- [ ] **Step 4: Use the resolver in `inside_outside`'s evaluate** (replace the `center`/`extents` read)

```ts
    evaluate: ({ constraint, instance, profile }) => {
      const region = maskRegion(profile, str(constraint.params.mask), instance);
      const center = region?.center ?? ((constraint.params.center as V3) ?? [0, 0, 0]);
      const extents = region?.extents ?? ((constraint.params.extents as V3) ?? [1, 1, 1]);
      const mode = str(constraint.params.mode) === 'outside' ? 'outside' : 'inside';
      const p = instance.transform.pos;
      const dx = extents[0] - Math.abs(p[0] - center[0]);
      const dy = extents[1] - Math.abs(p[1] - center[1]);
      const inside = Math.min(dx, dy);
      const value_m = mode === 'inside' ? inside : -inside;
      return { value_m, detail: `${mode} region (margin ${inside.toFixed(2)}m)` };
    },
```

Add `'mask'` to `inside_outside`'s `params` array.

- [ ] **Step 5: Run tests + tsc**

Run: `npx vitest run src/plumb/plumb.test.ts` → PASS
Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors

- [ ] **Step 6: Commit**

```bash
git add mcp-tools/hayba-mcp/src/plumb/primitives.ts mcp-tools/hayba-mcp/src/plumb/plumb.test.ts
git commit -m "feat(plumb): mask-referencing in primitives (resolve region by mask id)"
```

---

### Task 4: Constraint graph model + compile

**Files:**
- Create: `mcp-tools/hayba-mcp/src/plumb/graph.ts`
- Modify: `mcp-tools/hayba-mcp/src/plumb/index.ts` (re-export)
- Test: `mcp-tools/hayba-mcp/src/plumb/graph.test.ts`

**Interfaces:**
- Produces:
  - `ConstraintGraph = { nodes: GraphNode[]; edges: GraphEdge[] }`.
  - `GraphNode` discriminated on `kind: 'mask' | 'geometry' | 'primitive' | 'gate' | 'verdict'`.
  - `compileGraph(graph: ConstraintGraph, binding: ConstraintBinding): Constraint[]` — turns each primitive node + its wired mask into a `Constraint` (mask edge → `params.mask`).
  - `constraintsToGraph(constraints: Constraint[]): ConstraintGraph` — migration: one primitive node per flat constraint, wired to a single geometry node + verdict.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { compileGraph, constraintsToGraph, type ConstraintGraph } from './graph.js';
import type { Constraint } from './index.js';

describe('constraint graph compile', () => {
  it('compiles a primitive node wired to a mask into a Constraint', () => {
    const g: ConstraintGraph = {
      nodes: [
        { id: 'm1', kind: 'mask', maskId: 'swing_front' },
        { id: 'p1', kind: 'primitive', primitive: 'clearance', params: { min_m: 0.9 }, hard: true },
        { id: 'v', kind: 'verdict' },
      ],
      edges: [{ from: 'm1', to: 'p1' }, { from: 'p1', to: 'v' }],
    };
    const cs = compileGraph(g, { asset: '/Game/Door' });
    expect(cs.length).toBe(1);
    expect(cs[0].primitive).toBe('clearance');
    expect(cs[0].params.mask).toBe('swing_front');
    expect(cs[0].params.min_m).toBe(0.9);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].binding.asset).toBe('/Game/Door');
  });

  it('round-trips flat constraints through constraintsToGraph -> compileGraph', () => {
    const flat: Constraint[] = [{ id: 'g', primitive: 'grounded', params: { tolerance_m: 0.05 }, binding: { asset: '/Game/Tree' } }];
    const g = constraintsToGraph(flat);
    const back = compileGraph(g, { asset: '/Game/Tree' });
    expect(back[0].primitive).toBe('grounded');
    expect(back[0].params.tolerance_m).toBe(0.05);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plumb/graph.test.ts`
Expected: FAIL — `./graph.js` does not exist.

- [ ] **Step 3: Create `graph.ts`**

```ts
// Constraint graph: the serialized form the UE node editor authors and the AI
// emits. A graph is a CLOSED, typed node set; it compiles down to the flat
// Constraint[] the shipped evaluator runs (graph = source of truth, flat =
// compiled artifact). No operators, no branches — the same fill-values-only
// guarantee as the primitive set, expressed as nodes.

import type { Constraint, ConstraintBinding } from './contracts.js';

export type GraphNode =
  | { id: string; kind: 'mask'; maskId: string }
  | { id: string; kind: 'geometry' }
  | { id: string; kind: 'primitive'; primitive: string; params?: Record<string, unknown>; hard?: boolean; note?: string }
  | { id: string; kind: 'gate' }
  | { id: string; kind: 'verdict' };

export interface GraphEdge { from: string; to: string; }

export interface ConstraintGraph { nodes: GraphNode[]; edges: GraphEdge[]; }

/** Compile a graph to flat Constraints: one per primitive node. A mask edge
 *  into a primitive node sets params.mask = that mask's id. */
export function compileGraph(graph: ConstraintGraph, binding: ConstraintBinding): Constraint[] {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const out: Constraint[] = [];
  let i = 0;
  for (const node of graph.nodes) {
    if (node.kind !== 'primitive') continue;
    const params: Record<string, unknown> = { ...(node.params ?? {}) };
    // find a mask edge feeding this primitive node
    for (const e of graph.edges) {
      if (e.to !== node.id) continue;
      const src = byId.get(e.from);
      if (src?.kind === 'mask') params.mask = src.maskId;
    }
    out.push({ id: `${node.id}#${i++}`, primitive: node.primitive, params, binding, hard: node.hard, note: node.note });
  }
  return out;
}

/** Migration: wrap each flat constraint as a primitive node fed by one geometry
 *  node, all flowing to a single verdict. */
export function constraintsToGraph(constraints: Constraint[]): ConstraintGraph {
  const nodes: GraphNode[] = [{ id: 'geom', kind: 'geometry' }, { id: 'verdict', kind: 'verdict' }];
  const edges: GraphEdge[] = [];
  constraints.forEach((c, i) => {
    const nid = `p${i}`;
    nodes.push({ id: nid, kind: 'primitive', primitive: c.primitive, params: c.params, hard: c.hard, note: c.note });
    edges.push({ from: 'geom', to: nid });
    edges.push({ from: nid, to: 'verdict' });
  });
  return { nodes, edges };
}
```

- [ ] **Step 4: Re-export from `index.ts`**

```ts
export { compileGraph, constraintsToGraph } from './graph.js';
export type { ConstraintGraph, GraphNode, GraphEdge } from './graph.js';
```

- [ ] **Step 5: Run tests + tsc**

Run: `npx vitest run src/plumb/graph.test.ts` → PASS
Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors

- [ ] **Step 6: Commit**

```bash
git add mcp-tools/hayba-mcp/src/plumb/graph.ts mcp-tools/hayba-mcp/src/plumb/index.ts mcp-tools/hayba-mcp/src/plumb/graph.test.ts
git commit -m "feat(plumb): constraint graph model + compile to flat constraints"
```

---

### Task 5: Mask MCP tools (`plumb_mask_add` / `plumb_mask_remove`)

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/plumb/tools.ts` (add handlers + schemas)
- Modify: `mcp-tools/hayba-mcp/src/tools/index.ts` (register + reg)
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/register.ts` (`ALWAYS_ON_META` + `passthrough`)
- Modify: `mcp-tools/hayba-mcp/tests/routing-integration.test.ts` (fixture)
- Test: `mcp-tools/hayba-mcp/src/tools/plumb/tools.test.ts`

**Interfaces:**
- Consumes: `addMask`, `removeMask`, `Mask` from `../../plumb/index.js`.
- Produces:
  - `plumbMaskAddSchema` + `plumbMaskAddHandler(args): { ok: boolean; profile?: unknown; error?: string }` — args: `{ asset, id, type, color?, source?, confidence?, locked?, triangles?, shape?, detail? }`.
  - `plumbMaskRemoveSchema` + `plumbMaskRemoveHandler(args): { ok: boolean; removed: boolean }`.

- [ ] **Step 1: Write the failing test** (in `tools.test.ts`)

```ts
import { plumbMaskAddHandler, plumbMaskRemoveHandler } from './tools.js';
import { putProfile, bakeProfile } from '../../plumb/index.js';
// ... within a describe with setProfilesPath beforeEach (see existing block) ...
it('adds and removes a volume mask via the tool', async () => {
  putProfile(bakeProfile({ asset_id: '/Game/Door', origin_cm: [0,0,0], extent_cm: [50,10,100] }, 'now'));
  const add = await plumbMaskAddHandler({ asset: '/Game/Door', id: 'swing_front', type: 'volume', shape: { kind: 'box', transform: { pos: [0,1,0], quat: [0,0,0,1], scale: [1,1,1] }, extents: [1,1,2] } });
  expect(add.ok).toBe(true);
  const rm = await plumbMaskRemoveHandler({ asset: '/Game/Door', mask_id: 'swing_front' });
  expect(rm.removed).toBe(true);
});
it('mask_add errors with no base profile', async () => {
  const r = await plumbMaskAddHandler({ asset: '/Game/Nope', id: 'm', type: 'surface', triangles: [1] });
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tools/plumb/tools.test.ts -t mask`
Expected: FAIL — handlers not exported.

- [ ] **Step 3: Add schemas + handlers to `tools.ts`**

```ts
const maskShapeSchema = z.object({
  kind: z.enum(['box', 'sphere', 'capsule', 'convex']),
  transform: z.object({ pos: vec3, quat: vec4, scale: vec3 }),
  extents: vec3.optional(),
  radius: z.number().optional(),
  points: z.array(vec3).optional(),
});

export const plumbMaskAddSchema = {
  asset: z.string(),
  id: z.string(),
  type: z.enum(['surface', 'volume']),
  color: z.string().optional(),
  source: z.enum(['ai', 'human']).optional(),
  confidence: z.number().min(0).max(1).optional(),
  locked: z.boolean().optional(),
  triangles: z.array(z.number().int()).optional(),
  shape: maskShapeSchema.optional(),
  detail: z.string().optional(),
};
export async function plumbMaskAddHandler(args: {
  asset: string; id: string; type: 'surface' | 'volume'; color?: string;
  source?: 'ai' | 'human'; confidence?: number; locked?: boolean;
  triangles?: number[]; shape?: import('../../plumb/index.js').Mask['shape']; detail?: string;
}): Promise<{ ok: boolean; profile?: unknown; error?: string }> {
  const mask = {
    id: args.id, type: args.type, color: args.color ?? '#4488ff',
    source: args.source ?? 'human', confidence: args.confidence ?? (args.source === 'ai' ? 0.7 : 1),
    locked: args.locked ?? false, triangles: args.triangles, shape: args.shape, detail: args.detail,
  };
  const merged = addMask(args.asset, mask);
  if (!merged) return { ok: false, error: `no baked profile for "${args.asset}" — run plumb_profile_bake first` };
  return { ok: true, profile: merged };
}

export const plumbMaskRemoveSchema = { asset: z.string(), mask_id: z.string() };
export async function plumbMaskRemoveHandler(args: { asset: string; mask_id: string }): Promise<{ ok: boolean; removed: boolean }> {
  return { ok: true, removed: removeMask(args.asset, args.mask_id) };
}
```

Add `addMask, removeMask` to the existing `from '../../plumb/index.js'` import.

- [ ] **Step 4: Register both tools in `index.ts`** (after `plumb_profile_get`)

```ts
  server.tool('plumb_mask_add',
    'Add or update a mask (surface = triangle set; volume = translucent shape) on a baked profile. Surface/volume masks are the regions constraints reference.',
    plumbMaskAddSchema, async (a) => j(await plumbMaskAddHandler(a)));
  server.tool('plumb_mask_remove',
    'Remove a mask from a profile by id.',
    plumbMaskRemoveSchema, async (a) => j(await plumbMaskRemoveHandler(a)));
```

Add to the import block at top of `index.ts`:

```ts
  plumbMaskAddSchema, plumbMaskAddHandler,
  plumbMaskRemoveSchema, plumbMaskRemoveHandler,
```

Add `reg(...)` entries in `recordEagerSchemas`:

```ts
  reg('plumb_mask_add', plumbMaskAddSchema, 'low', '{ok, profile|error}');
  reg('plumb_mask_remove', plumbMaskRemoveSchema, 'low', '{ok, removed}');
```

- [ ] **Step 5: Add to `ALWAYS_ON_META` + `passthrough` in `register.ts`, and the routing-integration fixture**

In `register.ts`: add `'plumb_mask_add'`, `'plumb_mask_remove'` to the `ALWAYS_ON_META` set and a `passthrough('plumb_mask_add'); passthrough('plumb_mask_remove');` after the existing plumb passthroughs.

In `tests/routing-integration.test.ts`: add `['plumb_mask_add', 'plumb'], ['plumb_mask_remove', 'plumb'],` to the fixture `tools` array.

- [ ] **Step 6: Run tests + tsc + build**

Run: `npx vitest run src/tools/plumb tests/routing-integration.test.ts` → PASS
Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors
Run: `npx tsc` → emits dist (EMIT_EXIT 0)

- [ ] **Step 7: Commit**

```bash
git add mcp-tools/hayba-mcp/src/tools/plumb mcp-tools/hayba-mcp/src/tools/index.ts mcp-tools/hayba-mcp/src/tools/routing/register.ts mcp-tools/hayba-mcp/tests/routing-integration.test.ts
git commit -m "feat(plumb): plumb_mask_add / plumb_mask_remove MCP tools"
```

---

### Task 6: Full-suite regression + memory update

**Files:** none (verification + memory)

- [ ] **Step 1: Run the full suite, confirm no NEW failures**

Run: `npx vitest run`
Expected: the 27 pre-existing UE-mock/python failures remain (baseline); all `plumb`/`graph`/`tools`/`routing-integration` tests PASS. If any plumb/graph/tools test fails, fix before proceeding.

- [ ] **Step 2: Typecheck + emit**

Run: `npx tsc --noEmit -p tsconfig.json` → 0 errors; `npx tsc` → EMIT_EXIT 0

- [ ] **Step 3: Update the project memory**

Append Plan-A completion (surface_contact #11, mask model, mask-referencing, graph compile, mask tools) to `C:\Users\Admin\.claude\projects\D--Hackathons-hayba\memory\project_mcp_ux_validation_overhaul.md`, noting Plan B (UE Studio window) and Plan C (library/QoL) remain.

- [ ] **Step 4: Commit** (if memory is in-repo it is not — memory lives outside the repo; skip git for it)

No repo commit needed for memory; Plan A's code commits already landed in Tasks 1-5.

---

## Self-Review

**Spec coverage:**
- §2.3 11th primitive `surface_contact` → Task 1. ✔
- §5 mask data model → Task 2. ✔
- §2.2 mask-referencing constraints → Task 3. ✔
- §4 constraint graph (model + compile, the TS half) → Task 4. ✔
- §11 "new: mask MCP tools" → Task 5. ✔
- §4.3 AI authors into the graph → the graph model (Task 4) + mask tools (Task 5) are the TS surface the agent calls; the live UE authoring is Plan B (out of scope here, noted).
- §6 `plumb_study` orchestration tool → deferred to Plan B (needs the UE "Study" button signal); the underlying mask/graph TS surface ships here. Noted gap, intentional.
- §3, §7, §8, §10 (Studio window, library, bulk, overlay) → Plan B / Plan C, out of scope.

**Placeholder scan:** No TBD/TODO; every code step has complete code. ✔

**Type consistency:** `Mask` shape identical across contracts (Task 2), resolver (Task 3), tools (Task 5). `compileGraph`/`constraintsToGraph` signatures consistent (Task 4). `addMask`/`removeMask`/`getMask` names consistent across Tasks 2 and 5. ✔

**Scope:** Plan A is a single coherent subsystem (the TS foundation), independently testable, no UE rebuild. Plans B and C are separate. ✔
