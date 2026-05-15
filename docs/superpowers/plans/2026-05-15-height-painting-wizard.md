# Height Painting Wizard Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new pre-bake wizard step between `continents` and `boundaries` that lets the user sculpt per-cell elevation values directly on the 3D globe via brushes (raise/lower/smooth/flatten/noise), with masks, falloffs, undo, and a live displaced height-ramp preview.

**Architecture:** Three TS modules with clean seams — `HeightPainter` (pure state + undo), `PainterMesh` (three.js preview), `HeightPaintPanel` (React UI). Two new `Vec<f32>` / `Vec<u8>` fields on `WizardDraft` carry painted values to Rust at bake time. The Rust `bake_model` gains a single precedence rule: painted wins over continental-brush wins over preset.

**Tech Stack:** TypeScript, React 18, three.js 0.169, Tauri 2.x, Rust (existing sim), `tsx` for standalone test scripts (matches the existing `kdtree.test.ts` pattern — no jest/vitest), `cargo test` for Rust.

**Conventions to preserve:**
- Beige `#DED4C3` for text, accent `#B56A1D` for logo/highlight only, Segoe UI font.
- No all-caps in UI; sentence case.
- No `Co-Authored-By: Claude` trailer in commits.
- Feature branch per task chain — current branch is `chore/repo-restructure`; if it has drifted from a clean state when the implementer starts, create `feat/height-painting-wizard` from `main`.

**Spec:** `docs/superpowers/specs/2026-05-15-height-painting-wizard-design.md`

---

## File-by-file responsibilities

| File | Responsibility | Lines (target) |
|---|---|---|
| `apps/hayba-explorer/src/wizard/state.ts` | `WizardDraft` shape, defaults — extended with two arrays | +10 |
| `apps/hayba-explorer/src/wizard/paint/grid-neighbours.ts` | BFS over icosphere cells bounded by angular radius | ~50 |
| `apps/hayba-explorer/src/wizard/paint/falloff.ts` | linear / smooth / hard curves | ~30 |
| `apps/hayba-explorer/src/wizard/paint/brushMasks.ts` | round-soft / round-hard / splatter / ridge / cluster LUTs + sampler | ~120 |
| `apps/hayba-explorer/src/wizard/paint/brushes.ts` | raise / lower / smooth / flatten / noise per-cell mutators + value-noise FBM | ~120 |
| `apps/hayba-explorer/src/wizard/paint/HeightPainter.ts` | State, brush config, applyStroke, stroke records, undo/redo ring | ~250 |
| `apps/hayba-explorer/src/viewport/painterMesh.ts` | Displaced sphere + 1D height-ramp shader, brush cursor ring | ~180 |
| `apps/hayba-explorer/src/components/panels/HeightPaintPanel.tsx` | Side panel UI | ~250 |
| `apps/hayba-explorer/src/App.tsx` | Wire `paint-heights` phase, raycast → painter, bake handoff | +80 |
| `apps/hayba-explorer/src/components/PhaseStrip.tsx` | 5th step | +5 |
| `apps/hayba-explorer/src/wizard/ResolutionChips.tsx` | Tiers 128/160/192 + bake hints | +30 |
| `apps/hayba-explorer/src-tauri/src/wizard.rs` | Extend `WizardDraft`, merge in `bake_model`, tests | +60 |

---

## Task 1: WizardDraft TS state extension

**Files:**
- Modify: `apps/hayba-explorer/src/wizard/state.ts`

- [ ] **Step 1: Extend `WizardDraft` interface and default factory**

Open `apps/hayba-explorer/src/wizard/state.ts`. Replace the `WizardDraft` interface block with:

```ts
export interface WizardDraft {
  divisions: number;
  seed: number;
  preset: PresetName;
  /** Brush angular radius in radians on the unit sphere. */
  brush_radius_rad: number;
  /** Set of cell ids painted as continental crust. Duplicates tolerated. */
  continental_cells: number[];
  /** Per-plate-pair boundary type — key is sorted "min-max" plate ids. */
  boundary_types: Record<string, BoundaryType>;
  run_length_steps: number;
  dt_ma: number;
  /** Per-cell elevation overrides authored by the height painter.
   *  Length must equal n_cells once known; ignored where painted_mask[i] === 0.
   *  Range: [-1, +1]. */
  painted_elevations: number[];
  /** Per-cell flag: 1 = authored by height painter, 0 = use preset/continental default. */
  painted_mask: number[];
}
```

Replace `createDefaultDraft` with:

```ts
export function createDefaultDraft(divisions: number, seed: number): WizardDraft {
  return {
    divisions,
    seed,
    preset: "plates4",
    brush_radius_rad: 0.06,
    continental_cells: [],
    boundary_types: {},
    run_length_steps: 5,
    dt_ma: 0.5,
    painted_elevations: [],
    painted_mask: [],
  };
}
```

- [ ] **Step 2: TypeScript build check**

Run from `apps/hayba-explorer/`: `npx tsc --noEmit`
Expected: passes. No call site of `createDefaultDraft` needs updating — the two new fields are well-typed defaults.

- [ ] **Step 3: Commit**

```bash
git add apps/hayba-explorer/src/wizard/state.ts
git commit -m "feat(hayba-explorer): extend WizardDraft with painted_elevations + painted_mask"
```

---

## Task 2: Falloff curves

**Files:**
- Create: `apps/hayba-explorer/src/wizard/paint/falloff.ts`
- Create: `apps/hayba-explorer/src/wizard/paint/falloff.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/hayba-explorer/src/wizard/paint/falloff.test.ts`:

```ts
// Run: npx tsx src/wizard/paint/falloff.test.ts
import assert from "node:assert/strict";
import { falloff, type FalloffKind } from "./falloff";

function approx(a: number, b: number, eps = 1e-6): void {
  assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);
}

// At d=0 every falloff returns 1
for (const k of ["linear", "smooth", "hard"] as FalloffKind[]) {
  approx(falloff(k, 0), 1);
}

// At d>=1 every falloff returns 0
for (const k of ["linear", "smooth", "hard"] as FalloffKind[]) {
  approx(falloff(k, 1), 0);
  approx(falloff(k, 1.5), 0);
}

// Linear at d=0.5 → 0.5
approx(falloff("linear", 0.5), 0.5);

// Smooth at d=0.5 is between 0.4 and 0.6 (smoothstep-ish)
const s = falloff("smooth", 0.5);
assert.ok(s > 0.4 && s < 0.6, `smooth(0.5) = ${s}`);

// Hard is 1 everywhere inside disc except at edge
approx(falloff("hard", 0.9), 1);
approx(falloff("hard", 0.999), 1);

console.log("falloff.test.ts ✓");
```

- [ ] **Step 2: Run test to verify it fails**

Run from `apps/hayba-explorer/`: `npx tsx src/wizard/paint/falloff.test.ts`
Expected: fails — `./falloff` does not exist.

- [ ] **Step 3: Implement**

Create `apps/hayba-explorer/src/wizard/paint/falloff.ts`:

```ts
export type FalloffKind = "linear" | "smooth" | "hard";

/** Brush falloff at normalised distance `d` from the brush center.
 *  d=0 → 1 (full strength), d>=1 → 0 (outside the brush). */
export function falloff(kind: FalloffKind, d: number): number {
  if (d >= 1) return 0;
  if (d <= 0) return 1;
  switch (kind) {
    case "linear": return 1 - d;
    case "smooth": {
      // Standard smoothstep, inverted so d=0 → 1, d=1 → 0
      const t = 1 - d;
      return t * t * (3 - 2 * t);
    }
    case "hard":   return 1; // hard edge — full strength up to the disc rim
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/wizard/paint/falloff.test.ts`
Expected: `falloff.test.ts ✓`.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/wizard/paint/falloff.ts apps/hayba-explorer/src/wizard/paint/falloff.test.ts
git commit -m "feat(hayba-explorer): brush falloff curves (linear/smooth/hard)"
```

---

## Task 3: Grid neighbours BFS

**Files:**
- Create: `apps/hayba-explorer/src/wizard/paint/grid-neighbours.ts`
- Create: `apps/hayba-explorer/src/wizard/paint/grid-neighbours.test.ts`

This module walks the icosphere cell graph from a seed cell outward, accepting cells whose angular distance to a hit point is below a threshold. Cells are referenced by integer id; the grid is represented as a `neighbours: number[][]` adjacency list (one entry per cell, 5–6 neighbour ids each).

- [ ] **Step 1: Write the failing test**

Create `apps/hayba-explorer/src/wizard/paint/grid-neighbours.test.ts`:

```ts
// Run: npx tsx src/wizard/paint/grid-neighbours.test.ts
import assert from "node:assert/strict";
import { cellsInRadius } from "./grid-neighbours";

// Synthetic 7-cell flower: cell 0 at north pole, 6 cells in a ring at ~30°.
const NORTH: [number, number, number] = [0, 1, 0];
const RING_LAT_RAD = (Math.PI / 2) - 0.5; // sin = ~0.479, ~30° from north
const ringPositions: [number, number, number][] = [];
for (let i = 0; i < 6; i++) {
  const lon = (i / 6) * Math.PI * 2;
  ringPositions.push([
    Math.cos(RING_LAT_RAD) * Math.cos(lon),
    Math.sin(RING_LAT_RAD),
    Math.cos(RING_LAT_RAD) * Math.sin(lon),
  ]);
}
const positions: [number, number, number][] = [NORTH, ...ringPositions];
// Adjacency: center connects to all ring cells; ring cells connect to center + 2 ring siblings.
const neighbours: number[][] = [
  [1, 2, 3, 4, 5, 6],
  [0, 2, 6], [0, 1, 3], [0, 2, 4], [0, 3, 5], [0, 4, 6], [0, 5, 1],
];

// Tiny radius — only the seed cell.
{
  const out = cellsInRadius({ positions, neighbours, seedCellId: 0, hit: NORTH, radiusRad: 0.01 });
  assert.equal(out.length, 1);
  assert.equal(out[0].cellId, 0);
  assert.ok(out[0].distRad < 1e-6);
}

// Radius covering all 7 — flower fully accepted.
{
  const out = cellsInRadius({ positions, neighbours, seedCellId: 0, hit: NORTH, radiusRad: 1.0 });
  assert.equal(out.length, 7);
}

// Radius that includes seed + ring (0.5 rad covers the ring at ~0.5 rad away from pole).
{
  const out = cellsInRadius({ positions, neighbours, seedCellId: 0, hit: NORTH, radiusRad: 0.6 });
  assert.equal(out.length, 7);
}

// Radius excludes ring — only seed.
{
  const out = cellsInRadius({ positions, neighbours, seedCellId: 0, hit: NORTH, radiusRad: 0.3 });
  assert.equal(out.length, 1);
}

console.log("grid-neighbours.test.ts ✓");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/wizard/paint/grid-neighbours.test.ts`
Expected: fails — module does not exist.

- [ ] **Step 3: Implement**

Create `apps/hayba-explorer/src/wizard/paint/grid-neighbours.ts`:

```ts
export interface GridAdjacency {
  /** Unit-sphere position per cell, indexed by cell id. */
  positions: ReadonlyArray<readonly [number, number, number]> | Float32Array;
  /** Neighbour cell ids per cell. */
  neighbours: ReadonlyArray<ReadonlyArray<number>>;
}

export interface AffectedCell {
  cellId: number;
  /** Angular distance in radians from the hit point. */
  distRad: number;
}

export interface CellsInRadiusArgs extends GridAdjacency {
  seedCellId: number;
  hit: readonly [number, number, number];
  radiusRad: number;
}

function getPos(
  positions: CellsInRadiusArgs["positions"],
  id: number,
): [number, number, number] {
  if (positions instanceof Float32Array) {
    return [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]];
  }
  return positions[id] as [number, number, number];
}

function angularDist(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Both are unit vectors; clamp guards floating-point overshoot.
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/** BFS from `seedCellId` over the adjacency graph; return every cell whose
 *  angular distance to `hit` is < `radiusRad`. */
export function cellsInRadius(args: CellsInRadiusArgs): AffectedCell[] {
  const { positions, neighbours, seedCellId, hit, radiusRad } = args;
  const visited = new Set<number>();
  const out: AffectedCell[] = [];
  const queue: number[] = [seedCellId];
  visited.add(seedCellId);

  while (queue.length > 0) {
    const id = queue.shift()!;
    const pos = getPos(positions, id);
    const d = angularDist(pos, hit);
    if (d < radiusRad) {
      out.push({ cellId: id, distRad: d });
      for (const nb of neighbours[id]) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/wizard/paint/grid-neighbours.test.ts`
Expected: `grid-neighbours.test.ts ✓`.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/wizard/paint/grid-neighbours.ts apps/hayba-explorer/src/wizard/paint/grid-neighbours.test.ts
git commit -m "feat(hayba-explorer): icosphere BFS for brush footprint discovery"
```

---

## Task 4: Brush masks (LUTs + sampler)

**Files:**
- Create: `apps/hayba-explorer/src/wizard/paint/brushMasks.ts`
- Create: `apps/hayba-explorer/src/wizard/paint/brushMasks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/hayba-explorer/src/wizard/paint/brushMasks.test.ts`:

```ts
// Run: npx tsx src/wizard/paint/brushMasks.test.ts
import assert from "node:assert/strict";
import { sampleMask, MASK_NAMES, type MaskName } from "./brushMasks";

// Every named mask must accept (0, 0) (center) and (1, 1) (corner) without throwing
for (const name of MASK_NAMES) {
  const c = sampleMask(name, 0, 0);
  const e = sampleMask(name, 1, 1);
  assert.ok(c >= 0 && c <= 1, `${name} center = ${c}`);
  assert.ok(e >= 0 && e <= 1, `${name} corner = ${e}`);
}

// round-soft: center > edge
{
  const c = sampleMask("round-soft", 0, 0);
  const e = sampleMask("round-soft", 0.95, 0);
  assert.ok(c > e, `round-soft: center ${c} should exceed edge ${e}`);
  assert.ok(c > 0.9, `round-soft center should be near 1 (got ${c})`);
}

// round-hard: 1 inside, 0 outside
{
  assert.ok(sampleMask("round-hard", 0, 0) > 0.99);
  assert.ok(sampleMask("round-hard", 0.5, 0) > 0.99);
  assert.ok(sampleMask("round-hard", 1.01, 0) < 0.01);
}

// Out-of-bounds sampling returns 0
{
  assert.equal(sampleMask("round-soft", 2, 2), 0);
  assert.equal(sampleMask("round-soft", -2, 0), 0);
}

// ridge: stronger along one axis than perpendicular
{
  const along = sampleMask("ridge", 0, 0.3);
  const perp  = sampleMask("ridge", 0.3, 0);
  assert.ok(along > perp, `ridge along ${along} vs perp ${perp}`);
}

console.log("brushMasks.test.ts ✓");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/wizard/paint/brushMasks.test.ts`
Expected: fails.

- [ ] **Step 3: Implement**

Create `apps/hayba-explorer/src/wizard/paint/brushMasks.ts`:

```ts
export type MaskName = "round-soft" | "round-hard" | "splatter" | "ridge" | "cluster";

export const MASK_NAMES: readonly MaskName[] = [
  "round-soft", "round-hard", "splatter", "ridge", "cluster",
];

const SIZE = 64;

// Deterministic hash for splatter/cluster placement (no Math.random — masks must be stable).
function hash01(i: number): number {
  let h = (i + 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function buildRoundSoft(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE * 2 - 1;
      const v = (y + 0.5) / SIZE * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      // Gaussian sigma=0.4
      out[y * SIZE + x] = r > 1 ? 0 : Math.exp(-(r * r) / (2 * 0.4 * 0.4));
    }
  }
  return out;
}

function buildRoundHard(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE * 2 - 1;
      const v = (y + 0.5) / SIZE * 2 - 1;
      out[y * SIZE + x] = (u * u + v * v) <= 1 ? 1 : 0;
    }
  }
  return out;
}

function buildSplatter(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  const N_STAMPS = 8;
  const stamps: [number, number, number, number][] = [];
  for (let i = 0; i < N_STAMPS; i++) {
    const angle = hash01(i * 13 + 1) * Math.PI * 2;
    const dist  = hash01(i * 13 + 2) * 0.75;
    const radius = 0.18 + hash01(i * 13 + 3) * 0.12;
    const intensity = 0.5 + hash01(i * 13 + 4) * 0.5;
    stamps.push([Math.cos(angle) * dist, Math.sin(angle) * dist, radius, intensity]);
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE * 2 - 1;
      const v = (y + 0.5) / SIZE * 2 - 1;
      let val = 0;
      for (const [cx, cy, r, intensity] of stamps) {
        const du = u - cx, dv = v - cy;
        const dr = Math.sqrt(du * du + dv * dv) / r;
        if (dr < 1) val = Math.max(val, intensity * Math.exp(-(dr * dr) / 0.32));
      }
      out[y * SIZE + x] = u * u + v * v > 1 ? 0 : val;
    }
  }
  return out;
}

function buildRidge(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE * 2 - 1; // perpendicular axis
      const v = (y + 0.5) / SIZE * 2 - 1; // along axis (brush "up")
      if (u * u + v * v > 1) { out[y * SIZE + x] = 0; continue; }
      // Strong along v, narrow in u: gaussian on u with sigma=0.15
      const w = Math.exp(-(u * u) / (2 * 0.15 * 0.15)) * 0.8;
      out[y * SIZE + x] = w;
    }
  }
  return out;
}

function buildCluster(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  // 3 large gaussian blobs + 5 small ones
  const blobs: [number, number, number, number][] = [
    [-0.2,  0.2, 0.35, 1.0], [ 0.3, -0.1, 0.30, 0.9], [ 0.05,  0.4, 0.28, 0.85],
  ];
  for (let i = 0; i < 5; i++) {
    const angle = hash01(i * 17 + 100) * Math.PI * 2;
    const dist  = 0.35 + hash01(i * 17 + 101) * 0.4;
    blobs.push([Math.cos(angle) * dist, Math.sin(angle) * dist, 0.10 + hash01(i * 17 + 102) * 0.08, 0.5 + hash01(i * 17 + 103) * 0.3]);
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE * 2 - 1;
      const v = (y + 0.5) / SIZE * 2 - 1;
      if (u * u + v * v > 1) { out[y * SIZE + x] = 0; continue; }
      let val = 0;
      for (const [cx, cy, sigma, intensity] of blobs) {
        const du = u - cx, dv = v - cy;
        const d2 = du * du + dv * dv;
        val = Math.max(val, intensity * Math.exp(-d2 / (2 * sigma * sigma)));
      }
      out[y * SIZE + x] = val;
    }
  }
  return out;
}

const LUTS: Record<MaskName, Float32Array> = {
  "round-soft": buildRoundSoft(),
  "round-hard": buildRoundHard(),
  "splatter":   buildSplatter(),
  "ridge":      buildRidge(),
  "cluster":    buildCluster(),
};

/** Sample mask at normalised brush-local coordinates u, v ∈ [-1, +1].
 *  Returns 0 outside the unit disc. */
export function sampleMask(name: MaskName, u: number, v: number): number {
  if (u < -1 || u > 1 || v < -1 || v > 1) return 0;
  const lut = LUTS[name];
  const x = Math.min(SIZE - 1, Math.max(0, Math.floor((u * 0.5 + 0.5) * SIZE)));
  const y = Math.min(SIZE - 1, Math.max(0, Math.floor((v * 0.5 + 0.5) * SIZE)));
  return lut[y * SIZE + x];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/wizard/paint/brushMasks.test.ts`
Expected: `brushMasks.test.ts ✓`.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/wizard/paint/brushMasks.ts apps/hayba-explorer/src/wizard/paint/brushMasks.test.ts
git commit -m "feat(hayba-explorer): brush masks (soft/hard/splatter/ridge/cluster)"
```

---

## Task 5: Brushes (per-cell mutators) + FBM noise

**Files:**
- Create: `apps/hayba-explorer/src/wizard/paint/brushes.ts`
- Create: `apps/hayba-explorer/src/wizard/paint/brushes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/hayba-explorer/src/wizard/paint/brushes.test.ts`:

```ts
// Run: npx tsx src/wizard/paint/brushes.test.ts
import assert from "node:assert/strict";
import { applyMode, valueNoise, fbm, type BrushMode } from "./brushes";

function approx(a: number, b: number, eps = 1e-6): void {
  assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);
}

// raise increases elevation by w * 0.05
approx(applyMode({ mode: "raise", current: 0, w: 1, neighborAvg: 0, flattenTarget: 0, noiseSample: 0 }), 0.05);
approx(applyMode({ mode: "raise", current: 0.1, w: 0.5, neighborAvg: 0, flattenTarget: 0, noiseSample: 0 }), 0.125);

// lower decreases
approx(applyMode({ mode: "lower", current: 0.2, w: 1, neighborAvg: 0, flattenTarget: 0, noiseSample: 0 }), 0.15);

// smooth lerps toward neighborAvg
approx(applyMode({ mode: "smooth", current: 0.0, w: 0.5, neighborAvg: 0.4, flattenTarget: 0, noiseSample: 0 }), 0.2);

// flatten lerps toward target
approx(applyMode({ mode: "flatten", current: 0.0, w: 1.0, neighborAvg: 0, flattenTarget: 0.7, noiseSample: 0 }), 0.7);
approx(applyMode({ mode: "flatten", current: 0.5, w: 0.0, neighborAvg: 0, flattenTarget: -1, noiseSample: 0 }), 0.5);

// noise adds w * 0.05 * (sample - 0.5)
approx(applyMode({ mode: "noise", current: 0.2, w: 1.0, neighborAvg: 0, flattenTarget: 0, noiseSample: 1.0 }), 0.2 + 0.025);
approx(applyMode({ mode: "noise", current: 0.2, w: 1.0, neighborAvg: 0, flattenTarget: 0, noiseSample: 0.0 }), 0.2 - 0.025);

// w = 0 is a no-op for every mode
for (const m of ["raise", "lower", "smooth", "flatten", "noise"] as BrushMode[]) {
  approx(
    applyMode({ mode: m, current: 0.3, w: 0, neighborAvg: 0.9, flattenTarget: -0.5, noiseSample: 0.7 }),
    0.3,
  );
}

// valueNoise is deterministic
{
  const a = valueNoise(1.2, 3.4, 5.6, 42);
  const b = valueNoise(1.2, 3.4, 5.6, 42);
  approx(a, b);
}

// fbm produces values in [0, 1] for a few sample points
for (let i = 0; i < 10; i++) {
  const v = fbm(i * 0.7, i * 1.3, i * 0.5, 4, 42);
  assert.ok(v >= 0 && v <= 1, `fbm out of range: ${v}`);
}

console.log("brushes.test.ts ✓");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/wizard/paint/brushes.test.ts`
Expected: fails.

- [ ] **Step 3: Implement**

Create `apps/hayba-explorer/src/wizard/paint/brushes.ts`:

```ts
export type BrushMode = "raise" | "lower" | "smooth" | "flatten" | "noise";

export interface ApplyModeArgs {
  mode: BrushMode;
  current: number;
  w: number;              // brush weight = falloff * mask * strength
  neighborAvg: number;    // average of direct grid neighbours
  flattenTarget: number;  // flatten target elevation (-1..+1)
  noiseSample: number;    // FBM sample at this cell in [0, 1]
}

const PER_TICK_DELTA = 0.05;

/** Pure per-cell elevation update. Returns the new elevation (unclamped — caller clamps). */
export function applyMode(args: ApplyModeArgs): number {
  const { mode, current, w, neighborAvg, flattenTarget, noiseSample } = args;
  switch (mode) {
    case "raise":   return current + w * PER_TICK_DELTA;
    case "lower":   return current - w * PER_TICK_DELTA;
    case "smooth":  return current + (neighborAvg - current) * w;
    case "flatten": return current + (flattenTarget - current) * w;
    case "noise":   return current + w * PER_TICK_DELTA * (noiseSample - 0.5) * 2;
  }
}

// ── Deterministic value-noise FBM ────────────────────────────────────────

function hash3i(x: number, y: number, z: number, seed: number): number {
  let h = ((x | 0) * 374761393) ^ ((y | 0) * 668265263) ^ ((z | 0) * 2147483647) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Trilinear-interpolated value noise. Output in [0, 1]. */
export function valueNoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = smoothstep(fx), sy = smoothstep(fy), sz = smoothstep(fz);

  const v000 = hash3i(ix,     iy,     iz,     seed);
  const v100 = hash3i(ix + 1, iy,     iz,     seed);
  const v010 = hash3i(ix,     iy + 1, iz,     seed);
  const v110 = hash3i(ix + 1, iy + 1, iz,     seed);
  const v001 = hash3i(ix,     iy,     iz + 1, seed);
  const v101 = hash3i(ix + 1, iy,     iz + 1, seed);
  const v011 = hash3i(ix,     iy + 1, iz + 1, seed);
  const v111 = hash3i(ix + 1, iy + 1, iz + 1, seed);

  const x00 = v000 + (v100 - v000) * sx;
  const x10 = v010 + (v110 - v010) * sx;
  const x01 = v001 + (v101 - v001) * sx;
  const x11 = v011 + (v111 - v011) * sx;
  const y0 = x00 + (x10 - x00) * sy;
  const y1 = x01 + (x11 - x01) * sy;
  return y0 + (y1 - y0) * sz;
}

/** 4-octave FBM. Output normalised to [0, 1]. */
export function fbm(x: number, y: number, z: number, octaves: number, seed: number): number {
  let amp = 1, freq = 1, sum = 0, totalAmp = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, z * freq, seed + i * 31) * amp;
    totalAmp += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / totalAmp;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/wizard/paint/brushes.test.ts`
Expected: `brushes.test.ts ✓`.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/wizard/paint/brushes.ts apps/hayba-explorer/src/wizard/paint/brushes.test.ts
git commit -m "feat(hayba-explorer): brush mode kernels (raise/lower/smooth/flatten/noise) + FBM"
```

---

## Task 6: HeightPainter state module

**Files:**
- Create: `apps/hayba-explorer/src/wizard/paint/HeightPainter.ts`
- Create: `apps/hayba-explorer/src/wizard/paint/HeightPainter.test.ts`

This is the largest module. It binds elevations + touched + brush config + undo, exposes pointer-down/move/up methods, and produces the two arrays used at bake time.

- [ ] **Step 1: Write the failing test**

Create `apps/hayba-explorer/src/wizard/paint/HeightPainter.test.ts`:

```ts
// Run: npx tsx src/wizard/paint/HeightPainter.test.ts
import assert from "node:assert/strict";
import { HeightPainter, type BrushConfig } from "./HeightPainter";

const NORTH: [number, number, number] = [0, 1, 0];
// 7-cell flower as in grid-neighbours test.
const RING_LAT_RAD = (Math.PI / 2) - 0.5;
const positions: [number, number, number][] = [NORTH];
for (let i = 0; i < 6; i++) {
  const lon = (i / 6) * Math.PI * 2;
  positions.push([
    Math.cos(RING_LAT_RAD) * Math.cos(lon),
    Math.sin(RING_LAT_RAD),
    Math.cos(RING_LAT_RAD) * Math.sin(lon),
  ]);
}
const neighbours: number[][] = [
  [1, 2, 3, 4, 5, 6],
  [0, 2, 6], [0, 1, 3], [0, 2, 4], [0, 3, 5], [0, 4, 6], [0, 5, 1],
];

function defaultBrush(overrides: Partial<BrushConfig> = {}): BrushConfig {
  return {
    mode: "raise",
    radiusRad: 0.01, // tiny — only seed cell affected unless overridden
    strength: 1.0,
    falloff: "hard",
    mask: "round-hard",
    flattenTarget: 0,
    noiseScale: 4,
    ...overrides,
  };
}

function fresh(): HeightPainter {
  return new HeightPainter({ positions, neighbours, seed: 42, baseline: new Float32Array(7) });
}

// ── Basic stroke ─────────────────────────────────────────────────────────
{
  const p = fresh();
  p.beginStroke(defaultBrush());
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  const { painted_elevations, painted_mask } = p.toDraftFields();
  assert.equal(painted_mask[0], 1);
  assert.ok(painted_elevations[0] > 0, `expected raise, got ${painted_elevations[0]}`);
  for (let i = 1; i < 7; i++) assert.equal(painted_mask[i], 0);
}

// ── Strength = 0 is no-op ───────────────────────────────────────────────
{
  const p = fresh();
  p.beginStroke(defaultBrush({ strength: 0 }));
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  const { painted_elevations, painted_mask } = p.toDraftFields();
  assert.equal(painted_mask[0], 0);
  assert.equal(painted_elevations[0], 0);
}

// ── Undo restores pre-stroke state ──────────────────────────────────────
{
  const p = fresh();
  p.beginStroke(defaultBrush({ radiusRad: 1.0, mask: "round-hard", falloff: "hard" }));
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  p.undo();
  const { painted_elevations, painted_mask } = p.toDraftFields();
  for (let i = 0; i < 7; i++) {
    assert.equal(painted_mask[i], 0);
    assert.equal(painted_elevations[i], 0);
  }
}

// ── Redo restores post-stroke state ─────────────────────────────────────
{
  const p = fresh();
  p.beginStroke(defaultBrush());
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  const before = p.toDraftFields().painted_elevations[0];
  p.undo();
  p.redo();
  assert.equal(p.toDraftFields().painted_elevations[0], before);
}

// ── New stroke after undo clears redo ────────────────────────────────────
{
  const p = fresh();
  p.beginStroke(defaultBrush());
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  p.undo();
  p.beginStroke(defaultBrush());
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  // Can't redo — branched.
  assert.equal(p.redo(), false);
}

// ── Ring capacity = 20 (push 21, oldest dropped) ─────────────────────────
{
  const p = fresh();
  for (let i = 0; i < 21; i++) {
    p.beginStroke(defaultBrush());
    p.tickStroke({ seedCellId: 0, hit: NORTH });
    p.endStroke();
  }
  // 21 undos should saturate at 20 — final undo returns false
  for (let i = 0; i < 20; i++) assert.equal(p.undo(), true);
  assert.equal(p.undo(), false);
}

// ── Reset clears everything ──────────────────────────────────────────────
{
  const p = fresh();
  p.beginStroke(defaultBrush());
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  p.reset();
  const { painted_elevations, painted_mask } = p.toDraftFields();
  for (let i = 0; i < 7; i++) {
    assert.equal(painted_mask[i], 0);
    assert.equal(painted_elevations[i], 0);
  }
  assert.equal(p.undo(), false);
}

// ── Smooth converges to neighbor mean under repeated full-strength strokes ──
{
  const p = fresh();
  // First push the ring cells to 0.5, then smooth seed toward neighbour mean.
  p.beginStroke(defaultBrush({ radiusRad: 1.0, strength: 1.0, mode: "raise" }));
  for (let i = 0; i < 10; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  // Now flatten the seed cell back to 0 and smooth it.
  p.beginStroke(defaultBrush({ radiusRad: 0.01, mode: "flatten", flattenTarget: 0 }));
  for (let i = 0; i < 5; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  p.beginStroke(defaultBrush({ radiusRad: 0.01, mode: "smooth", strength: 1.0 }));
  for (let i = 0; i < 20; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  const e0 = p.toDraftFields().painted_elevations[0];
  // Should be pulled significantly toward the ring's elevation (which is at the +1 clamp).
  assert.ok(e0 > 0.7, `smooth should converge toward neighbour mean, got ${e0}`);
}

// ── Clamping to [-1, +1] ─────────────────────────────────────────────────
{
  const p = fresh();
  p.beginStroke(defaultBrush({ strength: 1.0, mode: "raise" }));
  for (let i = 0; i < 200; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  assert.equal(p.toDraftFields().painted_elevations[0], 1);

  p.beginStroke(defaultBrush({ strength: 1.0, mode: "lower" }));
  for (let i = 0; i < 500; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  assert.equal(p.toDraftFields().painted_elevations[0], -1);
}

console.log("HeightPainter.test.ts ✓");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx src/wizard/paint/HeightPainter.test.ts`
Expected: fails.

- [ ] **Step 3: Implement**

Create `apps/hayba-explorer/src/wizard/paint/HeightPainter.ts`:

```ts
import { cellsInRadius, type GridAdjacency } from "./grid-neighbours";
import { falloff, type FalloffKind } from "./falloff";
import { sampleMask, type MaskName } from "./brushMasks";
import { applyMode, fbm, type BrushMode } from "./brushes";

export interface BrushConfig {
  mode: BrushMode;
  radiusRad: number;
  strength: number;        // 0..1
  falloff: FalloffKind;
  mask: MaskName;
  flattenTarget: number;   // -1..+1
  noiseScale: number;      // FBM frequency multiplier
}

export interface PainterInit extends GridAdjacency {
  /** Master noise seed (used by noise-mode brush). */
  seed: number;
  /** Initial elevations per cell (defaults all zero if omitted). */
  baseline?: Float32Array;
}

interface StrokeRecord {
  cellIds: Uint32Array;
  prevValues: Float32Array;
  prevMask: Uint8Array;
}

const UNDO_CAPACITY = 20;

export class HeightPainter {
  readonly elevations: Float32Array;
  readonly touched: Uint8Array;
  readonly n: number;
  dirty: boolean = false;

  private readonly adj: GridAdjacency;
  private readonly seed: number;
  private readonly undoStack: StrokeRecord[] = [];
  private readonly redoStack: StrokeRecord[] = [];

  // Active stroke state
  private strokeActive: boolean = false;
  private currentBrush: BrushConfig | null = null;
  private capturedThisStroke: Set<number> = new Set();
  private currentRecord: { cellIds: number[]; prevValues: number[]; prevMask: number[] } | null = null;

  constructor(init: PainterInit) {
    this.adj = { positions: init.positions, neighbours: init.neighbours };
    this.n = init.neighbours.length;
    this.elevations = init.baseline ? new Float32Array(init.baseline) : new Float32Array(this.n);
    this.touched = new Uint8Array(this.n);
    this.seed = init.seed;
  }

  beginStroke(brush: BrushConfig): void {
    this.strokeActive = true;
    this.currentBrush = brush;
    this.capturedThisStroke = new Set();
    this.currentRecord = { cellIds: [], prevValues: [], prevMask: [] };
  }

  /** Apply one tick of the active brush at `hit`. Does nothing if no stroke is active. */
  tickStroke(args: { seedCellId: number; hit: readonly [number, number, number] }): void {
    if (!this.strokeActive || !this.currentBrush) return;
    const brush = this.currentBrush;
    if (brush.strength <= 0) return;

    const affected = cellsInRadius({
      ...this.adj,
      seedCellId: args.seedCellId,
      hit: args.hit,
      radiusRad: brush.radiusRad,
    });
    if (affected.length === 0) return;

    // Build tangent frame for mask sampling.
    const hit = args.hit;
    let upX = 0, upY = 1, upZ = 0;
    const dotUp = hit[0] * upX + hit[1] * upY + hit[2] * upZ;
    let tX = upX - hit[0] * dotUp, tY = upY - hit[1] * dotUp, tZ = upZ - hit[2] * dotUp;
    let tLen = Math.hypot(tX, tY, tZ);
    if (tLen < 1e-6) { tX = 1; tY = 0; tZ = 0; tLen = 1; }
    tX /= tLen; tY /= tLen; tZ /= tLen;
    // bitangent = hit × tangent
    const bX = hit[1] * tZ - hit[2] * tY;
    const bY = hit[2] * tX - hit[0] * tZ;
    const bZ = hit[0] * tY - hit[1] * tX;

    // Snapshot neighbour averages BEFORE mutation so smooth doesn't chase itself.
    const neighborAvg = new Float32Array(affected.length);
    for (let i = 0; i < affected.length; i++) {
      const id = affected[i].cellId;
      const nb = this.adj.neighbours[id];
      let sum = 0;
      for (const j of nb) sum += this.elevations[j];
      neighborAvg[i] = nb.length > 0 ? sum / nb.length : this.elevations[id];
    }

    for (let i = 0; i < affected.length; i++) {
      const { cellId, distRad } = affected[i];
      const pos = getPos(this.adj.positions, cellId);
      // Project (pos - hit) into tangent frame to get mask UV
      const dx = pos[0] - hit[0], dy = pos[1] - hit[1], dz = pos[2] - hit[2];
      const u = (dx * tX + dy * tY + dz * tZ) / brush.radiusRad;
      const v = (dx * bX + dy * bY + dz * bZ) / brush.radiusRad;

      const wFalloff = falloff(brush.falloff, distRad / brush.radiusRad);
      const wMask    = sampleMask(brush.mask, u, v);
      const w        = wFalloff * wMask * brush.strength;
      if (w <= 0) continue;

      this.captureBefore(cellId);
      const noiseSample = brush.mode === "noise"
        ? fbm(pos[0] * brush.noiseScale, pos[1] * brush.noiseScale, pos[2] * brush.noiseScale, 4, this.seed)
        : 0;
      let next = applyMode({
        mode: brush.mode,
        current: this.elevations[cellId],
        w,
        neighborAvg: neighborAvg[i],
        flattenTarget: brush.flattenTarget,
        noiseSample,
      });
      if (next > 1) next = 1;
      if (next < -1) next = -1;
      this.elevations[cellId] = next;
      this.touched[cellId] = 1;
    }
    this.dirty = true;
  }

  endStroke(): void {
    if (!this.strokeActive || !this.currentRecord) {
      this.strokeActive = false;
      this.currentBrush = null;
      this.currentRecord = null;
      this.capturedThisStroke = new Set();
      return;
    }
    if (this.currentRecord.cellIds.length > 0) {
      const rec: StrokeRecord = {
        cellIds: new Uint32Array(this.currentRecord.cellIds),
        prevValues: new Float32Array(this.currentRecord.prevValues),
        prevMask: new Uint8Array(this.currentRecord.prevMask),
      };
      this.undoStack.push(rec);
      if (this.undoStack.length > UNDO_CAPACITY) this.undoStack.shift();
      // New strokes branch from history — drop redo.
      this.redoStack.length = 0;
    }
    this.strokeActive = false;
    this.currentBrush = null;
    this.currentRecord = null;
    this.capturedThisStroke = new Set();
  }

  undo(): boolean {
    const rec = this.undoStack.pop();
    if (!rec) return false;
    // Capture the current state of these cells for redo
    const forward: StrokeRecord = {
      cellIds: rec.cellIds,
      prevValues: new Float32Array(rec.cellIds.length),
      prevMask: new Uint8Array(rec.cellIds.length),
    };
    for (let i = 0; i < rec.cellIds.length; i++) {
      const id = rec.cellIds[i];
      forward.prevValues[i] = this.elevations[id];
      forward.prevMask[i] = this.touched[id];
      this.elevations[id] = rec.prevValues[i];
      this.touched[id] = rec.prevMask[i];
    }
    this.redoStack.push(forward);
    this.dirty = true;
    return true;
  }

  redo(): boolean {
    const rec = this.redoStack.pop();
    if (!rec) return false;
    const backward: StrokeRecord = {
      cellIds: rec.cellIds,
      prevValues: new Float32Array(rec.cellIds.length),
      prevMask: new Uint8Array(rec.cellIds.length),
    };
    for (let i = 0; i < rec.cellIds.length; i++) {
      const id = rec.cellIds[i];
      backward.prevValues[i] = this.elevations[id];
      backward.prevMask[i] = this.touched[id];
      this.elevations[id] = rec.prevValues[i];
      this.touched[id] = rec.prevMask[i];
    }
    this.undoStack.push(backward);
    if (this.undoStack.length > UNDO_CAPACITY) this.undoStack.shift();
    this.dirty = true;
    return true;
  }

  reset(): void {
    this.elevations.fill(0);
    this.touched.fill(0);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.dirty = true;
  }

  /** Snapshot the painter's authored data into the shape Rust expects. */
  toDraftFields(): { painted_elevations: number[]; painted_mask: number[] } {
    return {
      painted_elevations: Array.from(this.elevations),
      painted_mask: Array.from(this.touched),
    };
  }

  /** Count of cells the user has authored at any point (cleared on reset/undo-to-empty). */
  countTouched(): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.touched[i] === 1) c++;
    return c;
  }

  private captureBefore(cellId: number): void {
    if (!this.currentRecord) return;
    if (this.capturedThisStroke.has(cellId)) return;
    this.capturedThisStroke.add(cellId);
    this.currentRecord.cellIds.push(cellId);
    this.currentRecord.prevValues.push(this.elevations[cellId]);
    this.currentRecord.prevMask.push(this.touched[cellId]);
  }
}

function getPos(
  positions: GridAdjacency["positions"],
  id: number,
): [number, number, number] {
  if (positions instanceof Float32Array) {
    return [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]];
  }
  return positions[id] as [number, number, number];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx src/wizard/paint/HeightPainter.test.ts`
Expected: `HeightPainter.test.ts ✓`.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/wizard/paint/HeightPainter.ts apps/hayba-explorer/src/wizard/paint/HeightPainter.test.ts
git commit -m "feat(hayba-explorer): HeightPainter — strokes, undo/redo, draft serialization"
```

---

## Task 7: PainterMesh — displaced sphere + height-ramp preview

**Files:**
- Create: `apps/hayba-explorer/src/viewport/painterMesh.ts`

No automated tests for three.js rendering. Validation is manual (Task 11 wires the mesh in and we screenshot).

- [ ] **Step 1: Implement**

Create `apps/hayba-explorer/src/viewport/painterMesh.ts`:

```ts
import * as THREE from "three";
import type { HeightPainter } from "../wizard/paint/HeightPainter";

const VERTEX = /* glsl */`
attribute float elevation;
varying float vElev;
uniform float uExaggeration;

void main() {
  vElev = elevation;
  vec3 p = position * (1.0 + elevation * uExaggeration);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAGMENT = /* glsl */`
precision highp float;
varying float vElev;
uniform vec3 uSunDir;
varying vec3 vNormalW;

vec3 heightRamp(float e) {
  // < -0.4 deep ocean, -0.4..0 shallow, 0..0.05 beach, 0.05..0.3 lowland green,
  // 0.3..0.7 highland brown, > 0.7 snow
  vec3 deep    = vec3(0.039, 0.180, 0.361);   // #0a2e5c
  vec3 shallow = vec3(0.290, 0.565, 0.784);   // #4a90c8
  vec3 beach   = vec3(0.784, 0.722, 0.604);   // #c8b89a
  vec3 low     = vec3(0.482, 0.627, 0.357);   // #7ba05b
  vec3 high    = vec3(0.541, 0.416, 0.227);   // #8a6a3a
  vec3 snow    = vec3(1.000, 1.000, 1.000);

  if (e < -0.4) return deep;
  if (e < 0.0)  return mix(deep, shallow, (e + 0.4) / 0.4);
  if (e < 0.05) return mix(shallow, beach, e / 0.05);
  if (e < 0.3)  return mix(beach, low, (e - 0.05) / 0.25);
  if (e < 0.7)  return mix(low, high, (e - 0.3) / 0.4);
  return mix(high, snow, min((e - 0.7) / 0.3, 1.0));
}

void main() {
  vec3 base = heightRamp(vElev);
  // Lambert shading using the analytic sphere normal (position direction).
  float lambert = max(dot(normalize(vNormalW), normalize(uSunDir)), 0.0);
  vec3 lit = base * (0.45 + 0.55 * lambert);
  gl_FragColor = vec4(lit, 1.0);
}
`;

// The fragment shader uses vNormalW but it's not declared in the vertex shader above —
// we send a normal varying by computing it as the normalised position direction.
const VERTEX_FULL = /* glsl */`
attribute float elevation;
varying float vElev;
varying vec3 vNormalW;
uniform float uExaggeration;

void main() {
  vElev = elevation;
  vNormalW = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec3 p = position * (1.0 + elevation * uExaggeration);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export interface PainterMeshHandle {
  object: THREE.Object3D;
  cursorRing: THREE.Line;
  /** Push painter state to GPU. Cheap when painter.dirty is false. */
  syncFromPainter(painter: HeightPainter): void;
  /** Update brush cursor position + radius. Pass null hit to hide. */
  setCursor(hit: [number, number, number] | null, radiusRad: number, pressed: boolean): void;
  dispose(): void;
}

export function buildPainterMesh(args: {
  positions: Float32Array;     // length n*3, unit sphere
  triangles: Uint32Array;
  initialElevations: Float32Array;
}): PainterMeshHandle {
  const { positions, triangles, initialElevations } = args;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(triangles, 1));
  const elevAttr = new THREE.BufferAttribute(new Float32Array(initialElevations), 1);
  elevAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("elevation", elevAttr);
  geom.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_FULL,
    fragmentShader: FRAGMENT,
    uniforms: {
      uExaggeration: { value: 0.05 },
      uSunDir:       { value: new THREE.Vector3(0.6, 0.5, 0.8).normalize() },
    },
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "hayba-painter-mesh";

  // Brush cursor ring — 64-segment circle on unit sphere, transformed each frame.
  const ringGeom = new THREE.BufferGeometry();
  const ringSegments = 64;
  const ringPositions = new Float32Array((ringSegments + 1) * 3);
  for (let i = 0; i <= ringSegments; i++) {
    const t = (i / ringSegments) * Math.PI * 2;
    ringPositions[i * 3 + 0] = Math.cos(t);
    ringPositions[i * 3 + 1] = 0;
    ringPositions[i * 3 + 2] = Math.sin(t);
  }
  ringGeom.setAttribute("position", new THREE.BufferAttribute(ringPositions, 3));
  const ringMat = new THREE.LineBasicMaterial({
    color: new THREE.Color("#DED4C3"),
    transparent: true,
    opacity: 0.85,
    depthTest: false,
  });
  const cursorRing = new THREE.Line(ringGeom, ringMat);
  cursorRing.renderOrder = 20;
  cursorRing.visible = false;
  cursorRing.frustumCulled = false;

  const group = new THREE.Group();
  group.name = "painter-group";
  group.add(mesh);
  group.add(cursorRing);

  const syncFromPainter = (painter: HeightPainter) => {
    if (!painter.dirty) return;
    elevAttr.array.set(painter.elevations);
    elevAttr.needsUpdate = true;
    painter.dirty = false;
  };

  const setCursor = (
    hit: [number, number, number] | null,
    radiusRad: number,
    pressed: boolean,
  ) => {
    if (!hit) { cursorRing.visible = false; return; }
    cursorRing.visible = true;
    ringMat.opacity = pressed ? 0.95 : 0.6;
    // Position ring at hit, scaled to chord length of `radiusRad`, oriented tangent.
    const r = Math.sin(radiusRad);
    cursorRing.scale.set(r, r, r);
    // Sit slightly above the sphere so the line isn't z-fought by the mesh
    const dist = Math.cos(radiusRad) * 1.001;
    cursorRing.position.set(hit[0] * dist, hit[1] * dist, hit[2] * dist);
    // Orient ring so its local Y axis matches `hit`.
    const up = new THREE.Vector3(hit[0], hit[1], hit[2]);
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    cursorRing.quaternion.copy(quat);
  };

  const dispose = () => {
    geom.dispose();
    mat.dispose();
    ringGeom.dispose();
    ringMat.dispose();
  };

  return { object: group, cursorRing, syncFromPainter, setCursor, dispose };
}
```

- [ ] **Step 2: TS build check**

Run from `apps/hayba-explorer/`: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/hayba-explorer/src/viewport/painterMesh.ts
git commit -m "feat(hayba-explorer): PainterMesh — displaced sphere + height-ramp + brush cursor"
```

---

## Task 8: Rust WizardDraft extension + bake precedence

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/wizard.rs`

- [ ] **Step 1: Write failing tests**

Open `apps/hayba-explorer/src-tauri/src/wizard.rs`. Locate `mod tests` near the bottom. Add the following tests *inside* the existing `mod tests` block (right after `user_brush_wins_over_preset`):

```rust
#[test]
fn painted_elevations_override_preset() {
    let mut draft = draft_for("plates2");
    let n_cells = 10242; // div=32
    draft.painted_elevations = vec![0.0; n_cells];
    draft.painted_mask = vec![0u8; n_cells];
    for i in 0..200 {
        draft.painted_elevations[i] = 0.8;
        draft.painted_mask[i] = 1;
    }
    let snap = bake_impl(&draft);
    // After bake the sim has stepped run_length_steps times so values may
    // drift slightly — confirm they're well above the preset baseline.
    let mut above_threshold = 0;
    for i in 0..200 {
        if snap.cell_elevation[i] > 0.5 { above_threshold += 1; }
    }
    assert!(above_threshold >= 180, "expected >=180 painted-high cells, got {}", above_threshold);
}

#[test]
fn painted_overrides_continental_brush() {
    let mut draft = draft_for("plates2");
    let n_cells = 10242;
    draft.continental_cells = (0..100).collect();
    draft.painted_elevations = vec![0.0; n_cells];
    draft.painted_mask = vec![0u8; n_cells];
    // First 50 cells painted to a deep negative — overrides continental-brush.
    for i in 0..50 {
        draft.painted_elevations[i] = -0.4;
        draft.painted_mask[i] = 1;
    }
    let snap = bake_impl(&draft);
    let mut below_zero = 0;
    for i in 0..50 {
        if snap.cell_elevation[i] < 0.0 { below_zero += 1; }
    }
    assert!(below_zero >= 40, "expected painted-negative to beat continental-mask, got {} below zero", below_zero);
}

#[test]
fn empty_painted_arrays_match_today_behaviour() {
    // No-op painter: empty arrays must leave bake bit-identical to the original.
    let mut draft_a = draft_for("plates2");
    draft_a.painted_elevations = vec![];
    draft_a.painted_mask = vec![];
    let snap_a = bake_impl(&draft_a);
    let snap_b = bake_impl(&draft_for("plates2"));
    assert_eq!(snap_a.cell_elevation.len(), snap_b.cell_elevation.len());
    for i in 0..snap_a.cell_elevation.len() {
        let diff = (snap_a.cell_elevation[i] - snap_b.cell_elevation[i]).abs();
        assert!(diff < 1e-6, "drift at cell {}: {} vs {}", i, snap_a.cell_elevation[i], snap_b.cell_elevation[i]);
    }
}

#[test]
fn continentality_derived_from_final_elevation() {
    let mut draft = draft_for("plates2");
    let n_cells = 10242;
    draft.continental_cells = (0..50).collect();
    draft.painted_elevations = vec![0.0; n_cells];
    draft.painted_mask = vec![0u8; n_cells];
    // Cells 0..50 are in continental_cells but painted negative — should bake as oceanic.
    for i in 0..50 {
        draft.painted_elevations[i] = -0.2;
        draft.painted_mask[i] = 1;
    }
    let snap = bake_impl(&draft);
    let mut oceanic = 0;
    for i in 0..50 {
        if snap.cell_continental[i] == 0 { oceanic += 1; }
    }
    assert!(oceanic >= 40, "painted-negative cells should be oceanic, got {} oceanic", oceanic);
}
```

Also update the `draft_for` helper in `mod tests` to initialize the new fields. Replace `draft_for` with:

```rust
fn draft_for(preset: &str) -> WizardDraft {
    WizardDraft {
        divisions: 32,
        seed: 7,
        preset: preset.into(),
        brush_radius_rad: 0.1,
        continental_cells: vec![],
        boundary_types: std::collections::HashMap::new(),
        run_length_steps: 1,
        dt_ma: 0.5,
        painted_elevations: vec![],
        painted_mask: vec![],
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `apps/hayba-explorer/src-tauri/`: `cargo test wizard --lib`
Expected: `error[E0063]`: missing fields `painted_elevations`, `painted_mask` in `WizardDraft`.

- [ ] **Step 3: Extend the `WizardDraft` struct**

In the same file, find the `WizardDraft` struct (around line 31) and replace it with:

```rust
#[derive(Debug, Deserialize)]
pub struct WizardDraft {
    pub divisions: u32,
    pub seed: u64,
    /// One of "plates2" / "plates3" / "plates4" / "plates5" / "plates5Uneven".
    pub preset: String,
    pub brush_radius_rad: f32,
    pub continental_cells: Vec<u32>,
    /// Per-boundary type assignment. Key = "min_id-max_id" (sorted plate
    /// pair, e.g. "1-3"). Value = "convergent" or "divergent". Missing
    /// pairs are left to the sim's default initial-omega.
    #[serde(default)]
    pub boundary_types: std::collections::HashMap<String, String>,
    pub run_length_steps: u32,
    pub dt_ma: f32,
    /// Per-cell elevation override from the height painter. When
    /// `painted_mask[i] == 1`, this value wins over the continental brush
    /// and preset HSV. Range: [-1, +1].
    #[serde(default)]
    pub painted_elevations: Vec<f32>,
    /// Flag per cell: 1 = authored by painter, 0 = use the default pipeline.
    #[serde(default)]
    pub painted_mask: Vec<u8>,
}
```

- [ ] **Step 4: Update bake precedence**

In `bake_model`, locate the per-cell elevation merge block (the "Step 4: per-cell crust override" comment, around line 597). Replace the entire `for fid in 0..n_cells { ... }` loop with:

```rust
    // ── Step 4: per-cell crust override. Precedence: painter > continental
    //  brush > preset HSV. Continental brush "lowland" floor drops from 0.5
    //  to 0.05 — barely above sea level, leaves room for the painter to
    //  sculpt mountains on top. Continentality is derived: elev > 0.
    const CONTINENTAL_BRUSH_FLOOR: f32 = 0.05;
    for fid in 0..n_cells {
        let info = &infos[fid as usize];
        let painted = draft
            .painted_mask
            .get(fid as usize)
            .copied()
            .unwrap_or(0)
            == 1;
        let elevation = if painted {
            draft.painted_elevations[fid as usize].clamp(-1.0, 1.0)
        } else if user_continental[fid as usize] {
            CONTINENTAL_BRUSH_FLOOR
        } else {
            info.preset_elevation
        };
        let cont = elevation > 0.0;
        if let Some(f) = model.fields.get_mut(fid as usize) {
            if cont {
                f.crust = Crust::new_continental();
                f.elevation = elevation.max(0.0);
                f.become_continental_lithosphere(200.0);
            } else {
                f.crust = Crust::new_oceanic();
                f.elevation = elevation.min(-0.0001);
                f.refresh_oceanic_lithosphere();
            }
        }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test wizard --lib`
Expected: all wizard tests pass, including the four new ones and the existing `user_brush_wins_over_preset` (which only asserts continental count, unaffected by the floor change).

- [ ] **Step 6: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/wizard.rs
git commit -m "feat(hayba-explorer): bake precedence — painter > continental brush > preset"
```

---

## Task 9: ResolutionChips — extend tiers to 192 + bake hints

**Files:**
- Modify: `apps/hayba-explorer/src/wizard/ResolutionChips.tsx`

- [ ] **Step 1: Extend the preset list**

Replace the `PRESETS` constant and the `Preset` interface block at the top of `apps/hayba-explorer/src/wizard/ResolutionChips.tsx` with:

```ts
export interface Preset {
  label: string;
  divisions: number;
  cellsLabel: string;
  /** Optional muted second line beneath the label — used for bake-time hints. */
  hint?: string;
}

export const PRESETS: Preset[] = [
  { label: "Quick",         divisions: 32,  cellsLabel: "10K"  },
  { label: "Balanced",      divisions: 64,  cellsLabel: "41K"  },
  { label: "High-Fidelity", divisions: 96,  cellsLabel: "92K"  },
  { label: "Ultra",         divisions: 128, cellsLabel: "164K", hint: "~2s per bake"  },
  { label: "Extreme",       divisions: 160, cellsLabel: "256K", hint: "~5s per bake"  },
  { label: "Insane",        divisions: 192, cellsLabel: "370K", hint: "~10s per bake — painter still snappy" },
];
```

- [ ] **Step 2: Render the hint under the label**

In the same file's `ResolutionChips` render, inside the `<span style={{ display: "inline-flex", ...}}>` that holds the label, change:

```tsx
              <span>{p.label}</span>
```

to:

```tsx
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span>{p.label}</span>
                {p.hint && (
                  <span style={{ fontSize: 10, color: colors.textMuted, letterSpacing: "0.04em" }}>
                    {p.hint}
                  </span>
                )}
              </span>
```

- [ ] **Step 3: TS build check**

Run from `apps/hayba-explorer/`: `npx tsc --noEmit`
Expected: passes.

The Select dropdown on the compose panel (which uses `RESOLUTION_PRESETS.map((r) => ({ value: r.divisions, label: ... }))`) will automatically pick up the new tiers via the dropdown — no change needed there.

- [ ] **Step 4: Commit**

```bash
git add apps/hayba-explorer/src/wizard/ResolutionChips.tsx
git commit -m "feat(hayba-explorer): extend resolution tiers to 128/160/192 with bake-time hints"
```

---

## Task 10: HeightPaintPanel (React UI)

**Files:**
- Create: `apps/hayba-explorer/src/components/panels/HeightPaintPanel.tsx`

This panel is purely a controlled view — it reads brush config and counts from the painter and writes them via callbacks. State actually lives in `App.tsx` (Task 11), which constructs the painter and feeds props.

- [ ] **Step 1: Implement**

Create `apps/hayba-explorer/src/components/panels/HeightPaintPanel.tsx`:

```tsx
import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import Select from "../Select";
import type { BrushConfig } from "../../wizard/paint/HeightPainter";
import type { BrushMode } from "../../wizard/paint/brushes";
import type { FalloffKind } from "../../wizard/paint/falloff";
import type { MaskName } from "../../wizard/paint/brushMasks";
import { MASK_NAMES } from "../../wizard/paint/brushMasks";

export interface HeightPaintPanelProps {
  brush: BrushConfig;
  paintedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onChangeBrush: (next: BrushConfig) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onBack: () => void;
  onNext: () => void;
}

const MODE_LABELS: Record<BrushMode, string> = {
  raise: "Raise",
  lower: "Lower",
  smooth: "Smooth",
  flatten: "Flatten",
  noise: "Noise",
};

export default function HeightPaintPanel(p: HeightPaintPanelProps): React.ReactElement {
  const set = <K extends keyof BrushConfig>(k: K, v: BrushConfig[K]): void =>
    p.onChangeBrush({ ...p.brush, [k]: v });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>
        <PropertySection heading="Height painter">
          <PropertyRow
            label="Mode"
            value={
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(Object.keys(MODE_LABELS) as BrushMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => set("mode", m)}
                    style={modeButtonStyle(m === p.brush.mode)}
                  >
                    {MODE_LABELS[m]}
                  </button>
                ))}
              </div>
            }
          />
          <PropertyRow
            label="Radius"
            value={
              <input
                type="range"
                min={0.02}
                max={0.30}
                step={0.005}
                value={p.brush.radiusRad}
                onChange={(e) => set("radiusRad", Number(e.target.value))}
                style={{ width: "100%" }}
              />
            }
          />
          <PropertyRow
            label="Strength"
            value={
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={p.brush.strength}
                onChange={(e) => set("strength", Number(e.target.value))}
                style={{ width: "100%" }}
              />
            }
          />
          <PropertyRow
            label="Falloff"
            value={
              <Select<FalloffKind>
                value={p.brush.falloff}
                onChange={(v) => set("falloff", v)}
                options={[
                  { value: "smooth", label: "Smooth" },
                  { value: "linear", label: "Linear" },
                  { value: "hard",   label: "Hard" },
                ]}
              />
            }
          />
          <PropertyRow
            label="Mask"
            value={
              <Select<MaskName>
                value={p.brush.mask}
                onChange={(v) => set("mask", v)}
                options={MASK_NAMES.map((n) => ({ value: n, label: n }))}
              />
            }
          />
          {p.brush.mode === "flatten" && (
            <PropertyRow
              label="Target"
              value={
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={p.brush.flattenTarget}
                  onChange={(e) => set("flattenTarget", Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              }
            />
          )}
        </PropertySection>

        <PropertySection heading="History">
          <PropertyRow
            label={`${p.paintedCount} cells painted`}
            noSeparator
            value={
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={p.onUndo} disabled={!p.canUndo} style={historyButtonStyle(p.canUndo)}>↶ Undo</button>
                <button onClick={p.onRedo} disabled={!p.canRedo} style={historyButtonStyle(p.canRedo)}>↷ Redo</button>
                <button onClick={p.onReset} style={historyButtonStyle(true)}>Reset</button>
              </div>
            }
          />
        </PropertySection>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "8px 0", borderTop: `1px solid ${colors.borderMid}` }}>
        <button onClick={p.onBack} style={navButtonStyle(false)}>← Continents</button>
        <button onClick={p.onNext} style={navButtonStyle(true)}>Boundaries →</button>
      </div>
    </div>
  );
}

function modeButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 9px",
    background: active ? "rgba(181,106,29,0.18)" : "transparent",
    border: `1px solid ${active ? colors.accent : colors.borderMid}`,
    borderRadius: 3,
    color: active ? colors.accentText : colors.beige,
    fontFamily: fonts.sans,
    fontSize: 12,
    cursor: "pointer",
    transition: "background 120ms, border-color 120ms",
  };
}

function historyButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    background: "transparent",
    border: `1px solid ${colors.borderMid}`,
    borderRadius: 3,
    color: enabled ? colors.beige : colors.textMuted,
    fontFamily: fonts.sans,
    fontSize: 12,
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: enabled ? 1 : 0.5,
  };
}

function navButtonStyle(primary: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "8px 12px",
    background: primary ? "rgba(181,106,29,0.18)" : "transparent",
    border: `1px solid ${primary ? colors.accent : colors.borderMid}`,
    borderRadius: 3,
    color: primary ? colors.accentText : colors.beige,
    fontFamily: fonts.sans,
    fontSize: 13,
    cursor: "pointer",
  };
}
```

- [ ] **Step 2: TS build check**

Run from `apps/hayba-explorer/`: `npx tsc --noEmit`
Expected: passes. If `colors.textMuted` or `colors.accentText` are missing, fall back to `colors.beige` for the same effect.

- [ ] **Step 3: Commit**

```bash
git add apps/hayba-explorer/src/components/panels/HeightPaintPanel.tsx
git commit -m "feat(hayba-explorer): HeightPaintPanel — brush mode/radius/strength/mask UI"
```

---

## Task 11: App.tsx — wire `paint-heights` phase + raycast

**Files:**
- Modify: `apps/hayba-explorer/src/App.tsx`
- Modify: `apps/hayba-explorer/src/components/PhaseStrip.tsx`

This task lights up the painter. After it: clicking on the paint-heights step actually sculpts the globe, undo/redo work, and bake carries the painted arrays through to Rust.

### 11a: PhaseStrip — add the 5th step

- [ ] **Step 1: Add the paint-heights step**

Open `apps/hayba-explorer/src/components/PhaseStrip.tsx`. The component has a fixed array of phase labels. Add `"paint heights"` between `"continents"` and `"boundaries"`. The phase keys used by `App.tsx` are `"compose" | "continents" | "boundaries" | "densities"` today — add `"paint-heights"` as a new key and `"paint heights"` as its label.

If the file currently has e.g.:

```tsx
const PHASES: { key: PhaseKey; label: string }[] = [
  { key: "compose",     label: "compose" },
  { key: "continents",  label: "continents" },
  { key: "boundaries",  label: "boundaries" },
  { key: "densities",   label: "densities" },
];
```

Replace with:

```tsx
const PHASES: { key: PhaseKey; label: string }[] = [
  { key: "compose",       label: "compose" },
  { key: "continents",    label: "continents" },
  { key: "paint-heights", label: "paint heights" },
  { key: "boundaries",    label: "boundaries" },
  { key: "densities",     label: "densities" },
];
```

Also extend the `PhaseKey` type (whether declared inline or imported) to include `"paint-heights"`. If `PhaseKey` is exported from this file, the import in `App.tsx` will pick it up automatically.

- [ ] **Step 2: TS build check**

Run: `npx tsc --noEmit`
Expected: errors will surface in `App.tsx` wherever `PhaseKey` is exhaustively switched. Those get fixed in 11b.

### 11b: App.tsx — painter + paint-heights phase

The exact edit shape depends on the current `App.tsx` layout. The implementer should locate the following anchors and apply the changes below.

- [ ] **Step 1: Imports**

At the top of `apps/hayba-explorer/src/App.tsx`, add:

```tsx
import { HeightPainter, type BrushConfig } from "./wizard/paint/HeightPainter";
import HeightPaintPanel from "./components/panels/HeightPaintPanel";
import { buildPainterMesh, type PainterMeshHandle } from "./viewport/painterMesh";
```

- [ ] **Step 2: Painter state**

Inside `App`, alongside the existing wizard state, add:

```tsx
const painterRef = React.useRef<HeightPainter | null>(null);
const painterMeshRef = React.useRef<PainterMeshHandle | null>(null);
const [paintedCount, setPaintedCount] = React.useState(0);
const [paintBrush, setPaintBrush] = React.useState<BrushConfig>({
  mode: "raise",
  radiusRad: 0.06,
  strength: 0.3,
  falloff: "smooth",
  mask: "round-soft",
  flattenTarget: 0,
  noiseScale: 4,
});
const [canUndo, setCanUndo] = React.useState(false);
const [canRedo, setCanRedo] = React.useState(false);
```

- [ ] **Step 3: Initialize painter when entering paint-heights**

Find the `useEffect` (or equivalent) that responds to phase changes — likely keyed on `[phase, partition]` or similar. Add a branch:

```tsx
React.useEffect(() => {
  if (phase !== "paint-heights") return;
  if (!partition) return;

  // Build painter from current grid topology
  const positions = new Float32Array(partition.cell_positions);
  // Convert grid neighbours into the adjacency shape the painter wants.
  // The Tauri-side `get_grid_triangles` returns triangles, not adjacency, so
  // we derive adjacency from triangles once here.
  const n = partition.n_cells;
  const adj: number[][] = Array.from({ length: n }, () => []);
  const tris = trianglesRef.current; // Uint32Array fetched from get_grid_triangles
  if (tris) {
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i], b = tris[i + 1], c = tris[i + 2];
      pushUnique(adj[a], b); pushUnique(adj[a], c);
      pushUnique(adj[b], a); pushUnique(adj[b], c);
      pushUnique(adj[c], a); pushUnique(adj[c], b);
    }
  }
  const painter = new HeightPainter({
    positions,
    neighbours: adj,
    seed: draft.seed,
  });
  painterRef.current = painter;
  setPaintedCount(0);
  setCanUndo(false);
  setCanRedo(false);

  // Mount PainterMesh (and hide GlobeMesh if mounted)
  if (tris && sceneRef.current) {
    const handle = buildPainterMesh({
      positions,
      triangles: tris,
      initialElevations: painter.elevations,
    });
    sceneRef.current.add(handle.object);
    painterMeshRef.current = handle;
    if (globeMeshRef.current) globeMeshRef.current.object.visible = false;
  }

  return () => {
    // Cleanup on leaving the phase
    if (painterMeshRef.current && sceneRef.current) {
      sceneRef.current.remove(painterMeshRef.current.object);
      painterMeshRef.current.dispose();
      painterMeshRef.current = null;
    }
    if (globeMeshRef.current) globeMeshRef.current.object.visible = true;
  };
}, [phase, partition]);

function pushUnique(arr: number[], v: number): void {
  if (!arr.includes(v)) arr.push(v);
}
```

(Adapt `trianglesRef`, `sceneRef`, `globeMeshRef`, `partition`, `draft` to whatever the current names are. If the painter needs the triangle list but it's not stored in a ref yet, fetch it in this effect via `invoke<number[]>("get_grid_triangles", { divisions: draft.divisions })` and convert to `Uint32Array`.)

- [ ] **Step 4: Pointer interactions for the painter**

Find the existing raycast handler that wires the continental brush. Branch on `phase === "paint-heights"` and call into the painter:

```tsx
const handlePointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
  if (phase !== "paint-heights" || !painterRef.current) {
    // existing handler
    return;
  }
  const hit = raycastToSphere(ev);
  if (!hit) return;
  const effectiveBrush = ev.shiftKey ? invertBrushMode(paintBrush) : paintBrush;
  painterRef.current.beginStroke(effectiveBrush);
  painterRef.current.tickStroke({ seedCellId: hit.cellId, hit: hit.point });
  applyPainterTick();
};
const handlePointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
  if (phase !== "paint-heights" || !painterRef.current) return;
  const hit = raycastToSphere(ev);
  if (hit && painterMeshRef.current) {
    painterMeshRef.current.setCursor(hit.point, paintBrush.radiusRad, ev.buttons === 1);
  } else if (painterMeshRef.current) {
    painterMeshRef.current.setCursor(null, 0, false);
  }
  if (ev.buttons === 1 && hit) {
    painterRef.current.tickStroke({ seedCellId: hit.cellId, hit: hit.point });
    applyPainterTick();
  }
};
const handlePointerUp = () => {
  if (phase !== "paint-heights" || !painterRef.current) return;
  painterRef.current.endStroke();
  setCanUndo(true);
  setCanRedo(false);
  setPaintedCount(painterRef.current.countTouched());
};

function applyPainterTick() {
  if (painterRef.current && painterMeshRef.current) {
    painterMeshRef.current.syncFromPainter(painterRef.current);
  }
}

function invertBrushMode(b: BrushConfig): BrushConfig {
  if (b.mode === "raise") return { ...b, mode: "lower" };
  if (b.mode === "lower") return { ...b, mode: "raise" };
  return b;
}
```

`raycastToSphere(ev)` should return `{ cellId, point: [x,y,z] }` — the existing continental-brush handler already does the unit-sphere raycast + nearest-cell lookup via the kd-tree; reuse that helper and just extend it to return the hit point alongside the cell id.

- [ ] **Step 5: Keyboard shortcuts**

Inside `App`, attach a keydown listener while the paint-heights phase is active:

```tsx
React.useEffect(() => {
  if (phase !== "paint-heights") return;
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "z" && (ev.ctrlKey || ev.metaKey) && !ev.shiftKey) {
      if (painterRef.current?.undo()) {
        applyPainterTick();
        setCanUndo(painterRef.current!.undoCount() > 0);
        setCanRedo(true);
        setPaintedCount(painterRef.current!.countTouched());
      }
    } else if (ev.key === "z" && (ev.ctrlKey || ev.metaKey) && ev.shiftKey) {
      if (painterRef.current?.redo()) {
        applyPainterTick();
        setCanUndo(true);
        setCanRedo(painterRef.current!.redoCount() > 0);
        setPaintedCount(painterRef.current!.countTouched());
      }
    } else if (ev.key === "[") {
      setPaintBrush((b) => ({ ...b, radiusRad: Math.max(0.02, b.radiusRad - 0.01) }));
    } else if (ev.key === "]") {
      setPaintBrush((b) => ({ ...b, radiusRad: Math.min(0.30, b.radiusRad + 0.01) }));
    } else if (ev.key === ",") {
      setPaintBrush((b) => ({ ...b, strength: Math.max(0, b.strength - 0.05) }));
    } else if (ev.key === ".") {
      setPaintBrush((b) => ({ ...b, strength: Math.min(1, b.strength + 0.05) }));
    } else if (ev.key >= "1" && ev.key <= "5") {
      const modes: BrushMode[] = ["raise", "lower", "smooth", "flatten", "noise"];
      const i = Number(ev.key) - 1;
      setPaintBrush((b) => ({ ...b, mode: modes[i] }));
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [phase]);
```

This relies on two new HeightPainter accessors: add `undoCount()` and `redoCount()` to `HeightPainter` (one-liners). To keep the plan complete:

In `apps/hayba-explorer/src/wizard/paint/HeightPainter.ts`, add these methods to the class:

```ts
undoCount(): number { return this.undoStack.length; }
redoCount(): number { return this.redoStack.length; }
```

- [ ] **Step 6: Bake handoff**

Find the place that builds the JSON for `bake_from_wizard`. Before the `invoke("bake_from_wizard", ...)` call, merge the painter's output:

```tsx
const paintedFields = painterRef.current
  ? painterRef.current.toDraftFields()
  : { painted_elevations: [], painted_mask: [] };
const finalDraft: WizardDraft = { ...draft, ...paintedFields };
const snap = await invoke<PlanetSnapshot>("bake_from_wizard", { draft: finalDraft });
```

- [ ] **Step 7: Render the panel**

Wherever the side-panel is dispatched on phase (the existing switch over `phase`), add a case for `"paint-heights"`:

```tsx
{phase === "paint-heights" && (
  <HeightPaintPanel
    brush={paintBrush}
    paintedCount={paintedCount}
    canUndo={canUndo}
    canRedo={canRedo}
    onChangeBrush={setPaintBrush}
    onUndo={() => {
      if (painterRef.current?.undo()) {
        applyPainterTick();
        setCanUndo(painterRef.current.undoCount() > 0);
        setCanRedo(true);
        setPaintedCount(painterRef.current.countTouched());
      }
    }}
    onRedo={() => {
      if (painterRef.current?.redo()) {
        applyPainterTick();
        setCanUndo(true);
        setCanRedo(painterRef.current.redoCount() > 0);
        setPaintedCount(painterRef.current.countTouched());
      }
    }}
    onReset={() => {
      if (!confirm("Reset all painted heights?")) return;
      painterRef.current?.reset();
      applyPainterTick();
      setCanUndo(false);
      setCanRedo(false);
      setPaintedCount(0);
    }}
    onBack={() => setPhase("continents")}
    onNext={() => setPhase("boundaries")}
  />
)}
```

- [ ] **Step 8: Build & smoke-test manually**

Run from `apps/hayba-explorer/`: `npm run build`
Expected: TypeScript and Vite both succeed.

Then run `npm run tauri dev`. Manually verify the smoke flow:

1. Open the app, walk through compose → continents (skip), arrive at paint heights.
2. The globe should switch to the height-ramp preview (oceans blue, no climate textures).
3. Pointer-down + drag with default brush raises terrain visibly; release commits a stroke.
4. Ctrl+Z restores the previous state.
5. Switching to "Lower" mode + drag drops elevation.
6. Click "Boundaries →" — phase advances, painter unmounts, the climate-shader globe returns (now showing painted topography under the climate shader).
7. Click "Start simulation" — bake completes successfully, snapshot reflects painted heights.

If a smoke step fails, fix and re-run.

- [ ] **Step 9: Take a paint-step screenshot**

Save a screenshot of the painter mid-stroke (continents lifted into mountains, ocean basin painted deep) to `docs/research/painter-mid-stroke-2026-05-15.png` for the project's visual-validation record.

- [ ] **Step 10: Commit**

```bash
git add apps/hayba-explorer/src/App.tsx \
        apps/hayba-explorer/src/components/PhaseStrip.tsx \
        apps/hayba-explorer/src/wizard/paint/HeightPainter.ts \
        docs/research/painter-mid-stroke-2026-05-15.png
git commit -m "feat(hayba-explorer): wire paint-heights phase — painter, raycast, hotkeys, bake handoff"
```

---

## Task 12: Start-simulation summary line

**Files:**
- Modify: `apps/hayba-explorer/src/App.tsx` (the start-confirmation modal, added earlier in the session)

- [ ] **Step 1: Add "N cells painted" to the modal summary**

Locate the confirmation modal's saved-config summary. Add one conditional line:

```tsx
{paintedCount > 0 && (
  <div style={{ color: colors.beige, fontSize: 12 }}>
    {paintedCount} cells painted
  </div>
)}
```

- [ ] **Step 2: Commit**

```bash
git add apps/hayba-explorer/src/App.tsx
git commit -m "feat(hayba-explorer): show painted-cell count in start-sim confirmation"
```

---

## Task 13: Divisions-change confirm modal

**Files:**
- Modify: `apps/hayba-explorer/src/App.tsx`

- [ ] **Step 1: Gate `onChangeDivisions`**

In the compose-phase wiring, wrap the existing divisions handler so a change clears the painter after a confirm:

```tsx
const handleChangeDivisions = (next: number) => {
  if (next === draft.divisions) return;
  const hasPaintedWork = painterRef.current && painterRef.current.countTouched() > 0;
  if (hasPaintedWork) {
    const ok = confirm("Changing detail level clears any painted heights. Continue?");
    if (!ok) return;
  }
  painterRef.current?.reset();
  setDraft({ ...draft, divisions: next });
};
```

Pass `handleChangeDivisions` to `ComposePanel` instead of the inline setter.

- [ ] **Step 2: Commit**

```bash
git add apps/hayba-explorer/src/App.tsx
git commit -m "feat(hayba-explorer): confirm + clear painted heights on divisions change"
```

---

## Task 14: End-to-end test suite + final tidy

**Files:**
- Modify: `apps/hayba-explorer/src/wizard/paint/HeightPainter.test.ts` (extend)

- [ ] **Step 1: Add a smooth-mode neighbour-snapshot regression test**

Append to `HeightPainter.test.ts`:

```ts
// ── Smooth-mode neighbour averaging uses the pre-tick snapshot ───────────
{
  // Set up: seed at +1, ring at -1. One smooth tick on seed at strength=1.0
  // should pull seed toward -1, not toward 0 (which would happen if the
  // implementation read neighbour values mid-loop after they'd been mutated).
  const p = fresh();
  p.beginStroke(defaultBrush({ radiusRad: 1.0, mode: "raise", strength: 1.0 }));
  for (let i = 0; i < 100; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  // Ring should be at +1 too. Force ring back to -1 manually via reset+lower.
  p.reset();
  for (let i = 1; i < 7; i++) {
    (p as any).elevations[i] = -1;
    (p as any).touched[i] = 1;
  }
  p.beginStroke(defaultBrush({ radiusRad: 0.01, mode: "smooth", strength: 1.0 }));
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  // After one smooth tick the seed should have moved from 0 toward -1 (the
  // neighbour mean), so its value should be negative.
  assert.ok(p.toDraftFields().painted_elevations[0] < -0.5, "smooth should snapshot neighbours");
}
```

- [ ] **Step 2: Run all unit tests**

```bash
cd apps/hayba-explorer
npx tsx src/wizard/paint/falloff.test.ts
npx tsx src/wizard/paint/grid-neighbours.test.ts
npx tsx src/wizard/paint/brushMasks.test.ts
npx tsx src/wizard/paint/brushes.test.ts
npx tsx src/wizard/paint/HeightPainter.test.ts
```

All five should print their `✓` lines.

- [ ] **Step 3: Run all Rust tests**

```bash
cd apps/hayba-explorer/src-tauri
cargo test --lib
```

Expected: all wizard tests pass.

- [ ] **Step 4: TS build**

```bash
cd apps/hayba-explorer
npm run build
```

Expected: passes.

- [ ] **Step 5: Final commit**

```bash
git add apps/hayba-explorer/src/wizard/paint/HeightPainter.test.ts
git commit -m "test(hayba-explorer): smooth-mode neighbour-snapshot regression"
```

---

## Verification checklist

After every task ships, the plan is done when:

- All five `*.test.ts` files print their `✓` lines under `npx tsx`.
- `cargo test --lib` passes in `src-tauri/`.
- `npm run build` passes in `apps/hayba-explorer/`.
- Manual smoke walks from compose → paint-heights → bake → step works visually and the painted topography is visible in the post-bake climate shader.
- The screenshot at `docs/research/painter-mid-stroke-2026-05-15.png` exists and shows obvious painted terrain.

When all four pass, run `superpowers:finishing-a-development-branch` to wrap.
