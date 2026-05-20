# Height Painting Wizard Phase — Design Spec

**Date:** 2026-05-15
**Status:** Approved for planning
**Sprint:** Pre-bake terrain authoring (prior sub-project to shader realism upgrades)

## Goal

Add a new wizard phase between `continents` and `boundaries` that lets the user sculpt per-cell elevation values directly on the 3D globe, replacing the current "binary continental mask → fixed 0.5 elevation" coarseness with brush-based bipolar height authoring.

## Architecture

The painter is layered into three modules with clean seams:

1. **`HeightPainter` (state module)** — pure TypeScript. Owns `elevations: Float32Array(n)`, `touched: Uint8Array(n)`, undo ring, current brush config. Exposes `applyStroke(brush, ray, dt)` and `undo()` / `redo()`. No three.js, no React. Testable with a fake grid.
2. **`PainterMesh` (preview module)** — three.js. Subscribes to the painter and re-uploads its `elevation` buffer attribute on dirty. Renders the displaced sphere with a 1D height-ramp fragment shader. Mounted only during the paint-heights phase.
3. **`HeightPaintPanel` (UI module)** — React. Side-panel controls, keyboard shortcuts, undo button. Reads and writes painter state.

The viewport wires raycast hits to `painter.applyStroke(...)`. At bake time, `App` reads `painter.toDraftFields()` → `{painted_elevations, painted_mask}` → added to the JSON payload sent to `bake_from_wizard`.

### Bake-time precedence (Rust)

For each cell, elevation is resolved by the following rule:

```rust
let elevation = if painted_here {
    draft.painted_elevations[fid as usize]   // painter-authored, -1..+1
} else if user_continental[fid as usize] {
    0.05                                     // continental-brush lowland floor
} else {
    info.preset_elevation                    // preset HSV-derived
};
let cont = elevation > 0.0;                  // continentality derived uniformly
```

The continental-brush default drops from `0.5` to `0.05` — barely above sea level, matching Earth's continental lowland mean. Painted strokes then sculpt up from there.

## File structure

**New files (frontend):**

```
apps/hayba-explorer/src/wizard/paint/
  HeightPainter.ts         # State, undo, applyStroke
  brushes.ts               # raise / lower / smooth / flatten / noise
  brushMasks.ts            # round-soft, round-hard, splatter, ridge, cluster
  falloff.ts               # linear / smooth / hard
  grid-neighbours.ts       # BFS over icosphere cells bounded by angular radius

apps/hayba-explorer/src/viewport/
  painterMesh.ts           # Lightweight displaced sphere + 1D height ramp

apps/hayba-explorer/src/components/panels/
  HeightPaintPanel.tsx     # Side panel: brush mode tabs, sliders, mask picker, undo
```

**Modified:**

- `apps/hayba-explorer/src/wizard/state.ts` — add `painted_elevations: number[]`, `painted_mask: number[]` to `WizardDraft`.
- `apps/hayba-explorer/src-tauri/src/wizard.rs` — extend `WizardDraft` (with `#[serde(default)]` for back-compat), merge painted values in `bake_model`.
- `apps/hayba-explorer/src/App.tsx` — add `"paint-heights"` to the phase chain after `continents`, mount `HeightPaintPanel` + `PainterMesh` for that phase, wire raycast hits.
- `apps/hayba-explorer/src/components/PhaseStrip.tsx` — gains the 5th step.
- `apps/hayba-explorer/src/wizard/ResolutionChips.tsx` — extend `PRESETS` with 128 / 160 / 192 tiers and bake-time hints.

## Data model

### TypeScript (`wizard/state.ts`)

```ts
export interface WizardDraft {
  divisions: number;
  seed: number;
  preset: PresetName;
  brush_radius_rad: number;
  continental_cells: number[];
  boundary_types: Record<string, BoundaryType>;
  run_length_steps: number;
  dt_ma: number;

  painted_elevations: number[];   // length n_cells, f32 values
  painted_mask: number[];         // length n_cells, 0 or 1
}
```

Both new arrays start zero-length in `createDefaultDraft()` and are sized once `n_cells` is known (after `start_wizard`).

### Rust (`wizard.rs`)

```rust
pub struct WizardDraft {
    // existing fields …
    #[serde(default)] pub painted_elevations: Vec<f32>,
    #[serde(default)] pub painted_mask:       Vec<u8>,
}
```

`#[serde(default)]` keeps existing tests and any persisted drafts compatible.

### Wire footprint

At div=32 (10,242 cells), `painted_elevations` (f32 array) + `painted_mask` (u8 array) ≈ 50 KB. At div=192 (~370K cells) ≈ 1.8 MB — still trivial across the Tauri bridge once per bake.

### Undo records

```ts
interface StrokeRecord {
  cellIds: Uint32Array;
  prevValues: Float32Array;
  prevMask: Uint8Array;
}
```

Ring capacity 20, kept entirely in JS. Rust never sees individual strokes.

## Brush system

### BrushConfig

```ts
interface BrushConfig {
  mode: "raise" | "lower" | "smooth" | "flatten" | "noise";
  radiusRad: number;        // angular radius on unit sphere
  strength: number;         // 0..1, default 0.3
  falloff: "linear" | "smooth" | "hard";
  mask: "round-soft" | "round-hard" | "splatter" | "ridge" | "cluster";
  flattenTarget: number;    // -1..+1, only consulted in flatten mode
  noiseScale: number;       // FBM frequency multiplier, noise mode only
}
```

### Stroke algorithm

For each pointer-move tick:

1. **Find affected cells.** BFS from `hit.cellId` over `grid.neighbours`, accept any cell whose unit-sphere angle to `hit.point` is `< radiusRad`.
2. **Compute per-cell brush weight:**
   ```
   d        = angularDist(cell, hit) / radiusRad
   wFalloff = falloffCurve(d)
   wMask    = sampleMask(maskName, polarUV)
   w        = wFalloff * wMask * strength
   ```
3. **Apply mode-specific delta:**
   - **raise**: `e += w * 0.05`
   - **lower**: `e -= w * 0.05`
   - **smooth**: `e = lerp(e, avgOfNeighbours, w)` (averages over `grid.neighbours` only — the 5–6 direct ring)
   - **flatten**: `e = lerp(e, flattenTarget, w)`
   - **noise**: `e += w * 0.05 * (fbm(pos * noiseScale) - 0.5)` (deterministic on seed + cell pos)
4. **Clamp** to `[-1, +1]` and set `touched[i] = 1`.
5. **Capture** the cell's pre-stroke value into the current `StrokeRecord` if not already captured.

### Per-tick base delta

`0.05` per tick at strength=1. At 60Hz a one-second hover at full strength saturates a cell from 0 to +1. Strength slider default = 0.3 — a one-second hover gives ~+0.9 delta, which feels right for "I want a mountain here".

### Brush masks

Each is a 64×64 `Float32Array` LUT, sampled in the brush's tangent frame (rotation fixed to world-up projected onto the tangent plane in v1):

- `round-soft` — gaussian, sigma=0.4 (default, matches existing continental-brush behaviour)
- `round-hard` — 1.0 inside disc, 0 outside
- `splatter` — 8 blue-noise-stamped circles with varying intensity
- `ridge` — thin tangential band, 0.8 along brush "up", 0.0 perpendicular
- `cluster` — 3 large gaussian blobs + 5 small ones

User-supplied mask uploads are deliberately out of scope for v1.

## Live preview (`PainterMesh`)

Geometry shares the triangle index list from `get_grid_triangles`. Positions are unit-sphere cell positions. One `elevation` buffer attribute, re-uploaded on `painter.dirty`.

**Vertex shader:** displace each vertex by `position * (1.0 + elevation * uExaggeration)`, with `uExaggeration = 0.05`.

**Fragment shader:** 1D height-ramp lookup by elevation value:
- `< -0.4` → deep ocean (`#0a2e5c`)
- `-0.4 .. 0` → shallow ocean (`#0a2e5c` → `#4a90c8` lerp)
- `0 .. +0.05` → coastline beige (`#c8b89a`)
- `+0.05 .. +0.3` → lowland green (`#7ba05b`)
- `+0.3 .. +0.7` → highland brown (`#8a6a3a`)
- `> +0.7` → snow (`#ffffff`)

Lambert lighting only (single sun). No climate, no atmosphere, no AO. The mesh is a sculpting surface — clarity over realism.

**Brush cursor:** a three.js `Line` ring that tracks the raycast hit, sized to `radiusRad`, drawn on top with no depth test. Pulses faintly when pointer is down.

**Phase lifecycle:**
- Entering paint-heights → hide/destroy `GlobeMesh`, mount `PainterMesh`.
- Leaving paint-heights → dispose `PainterMesh` (height-ramp texture + material released). `HeightPainter` state itself survives.
- Returning to paint-heights → rebuild `PainterMesh` fresh from existing painter state. No data loss.
- Changing `divisions` in compose → painter state cleared after a confirmation modal ("Changing detail level clears any painted heights").

## UX flow

### Phase chain

```
compose  →  continents  →  paint-heights  →  boundaries  →  densities  →  [Start sim]
```

### Paint-heights layout

```
┌────────────────────────────────────────────────────────────────┐
│ [logo]   compose · continents · paint heights · boundaries · densities │
├──────────────────────────────────────┬─────────────────────────┤
│                                      │  Height painter         │
│                                      │  ─────────────────────  │
│                                      │  Mode                   │
│      ╭───── 3D globe ──────╮         │  [Raise][Lower][Smooth] │
│      │   PainterMesh,      │         │  [Flatten][Noise]       │
│      │   height-ramp,      │         │                         │
│      │   brush ring at     │         │  Radius   ●─────○  0.06 │
│      │   cursor            │         │  Strength ●──○─────  .3 │
│      ╰─────────────────────╯         │  Falloff  (○)smooth     │
│                                      │           ( )linear     │
│                                      │           ( )hard       │
│                                      │  Mask     [soft ▾]      │
│                                      │  Target   ●─○──── -0.1  │
│                                      │     (flatten mode only) │
│                                      │                         │
│                                      │  ↶ Undo (ctrl-z)        │
│                                      │  Reset paint            │
│                                      │                         │
│                                      │  [← Continents] [Boundaries →] │
├──────────────────────────────────────┴─────────────────────────┤
│ status bar — phase, cell count, brush info                     │
└────────────────────────────────────────────────────────────────┘
```

### Pointer interactions

- **Hover** → brush ring follows raycast hit.
- **Pointer-down + drag** → continuous stroke. Pointer-up commits to undo ring.
- **Right-drag** → orbit camera (existing).
- **Scroll** → zoom (existing).
- **`[` / `]`** → shrink / grow radius.
- **`,` / `.`** → decrease / increase strength.
- **`1`..`5`** → cycle brush modes.
- **`Ctrl+Z` / `Ctrl+Shift+Z`** → undo / redo.
- **`Shift`-hold during stroke** → invert mode (raise↔lower) for that stroke.

### First-entry banner

One-line beige-rail status banner: *"Paint to raise, drag to draw, shift to invert. Optional — skip if you want the default terrain."*

### Skip experience

The "Boundaries →" button is always enabled. With zero painted cells, the bake is bit-identical to today's behaviour (preset HSV + continental-brush 0.05 floor). The wizard step is a true no-op when ignored.

### Bake confirmation modal

The existing start-simulation confirmation gets one extra summary line: *"X cells painted."* — only shown when X > 0.

## Undo system

### Capture rules

- On `pointerdown`, create empty `StrokeRecord` and `Set<number>` capturedThisStroke.
- Each tick within the stroke calls `captureBefore(cellId)` *before* mutation. No-op if already captured this stroke.
- On `pointerup`, freeze record (build typed arrays from the captured set) and push onto undo ring.

### Ring behaviour

- Capacity 20. Pushing onto a full ring drops the oldest entry.
- Any push clears the redo stack (standard branch-from-history semantics).

### Undo / redo operation

```ts
undo() {
  const rec = undoStack.pop();
  if (!rec) return;
  const forward = captureCurrentFor(rec.cellIds);  // for redo
  redoStack.push(forward);
  restore(rec);
  this.dirty = true;
}
```

Redo is symmetric.

### Edge cases

- **No-op strokes** (pointer down/up with no affected cells) → no record pushed.
- **Reset paint** → clears elevations, touched, undo, redo. Confirms via small modal.
- **Cross-step navigation** → undo history survives.
- **Divisions change** → painter and undo both cleared.

### Memory cost

A 300-cell stroke = `300 * (4 + 4 + 1) ≈ 3 KB`. Full ring of 20 ≈ 60 KB. Negligible.

## Extended resolution tiers

`apps/hayba-explorer/src/wizard/ResolutionChips.tsx` `PRESETS` extends to:

| Label | Divisions | Cells | Bake hint shown |
|---|---|---|---|
| Quick | 32 | ~10K | — |
| Balanced | 64 | ~41K | — |
| High-Fidelity | 96 | ~92K | — |
| Ultra | 128 | ~164K | "~2s per bake" |
| Extreme | 160 | ~256K | "~5s per bake" |
| Insane | 192 | ~370K | "~10s per bake — painter still snappy" |

Bake-time hint is a muted second line on each tier ≥ 128. Numbers are placeholder ranges to be tightened after a first benchmark on the dev machine.

## Testing strategy

### Pure-TS unit tests

- `HeightPainter.applyStroke` raises cells by the expected delta given a fake 7-cell grid.
- Strength = 0 is a no-op.
- Cells outside `radiusRad` are unchanged.
- Smooth-mode is idempotent at strength=0; converges to a constant under repeated application on a closed footprint.
- Flatten-mode lerps toward target.
- Noise-mode is deterministic given seed.
- Each falloff curve hits expected values at `d ∈ {0, 0.5, 1.0}`.
- Each mask returns expected weights at known sample points.

### Undo tests

- Stroke → undo → bit-identical to pre-stroke.
- Push 21 strokes → ring contains 20 (oldest dropped).
- Stroke → undo → redo → matches post-stroke.
- New stroke after undo clears redo stack.
- Reset clears both stacks.

### Rust bake tests

Extend `wizard.rs::tests`:

- `painted_elevations` overrides preset HSV: paint 200 cells to +0.8, assert post-bake `cell_elevation[i] ≈ 0.8`.
- `painted_elevations` overrides continental brush: cell in both `continental_cells` and `painted_mask` uses painted value, not 0.05.
- Empty `painted_elevations` + `painted_mask` (`Vec::new()`) leaves bake bit-identical to today (back-compat).
- Continentality derived from final elevation: paint a cell to -0.2 and assert `cell_continental[i] == 0`.

### Manual viewport validation

Per project policy (sim/viewer work needs visual screenshot validation), paint test includes screenshots at three stages:

- Empty painter (verifies baseline matches today)
- Mid-stroke (verifies live extrusion + height ramp)
- Fully sculpted continent (verifies bake produces the painted geometry)

### Integration test

A small script that constructs a `WizardDraft` with hand-authored `painted_elevations`, calls `bake_from_wizard`, asserts the resulting snapshot. Pattern matches the existing `bake_impl` test module — one more case.

### Out of scope for v1

- Pointer event delivery at 60Hz (needs DOM harness)
- Three.js `PainterMesh` visual diff testing
- Performance regression suite at div=192 (manual smoke only)

## Risks & open questions

- **Brush mask rotation.** v1 fixes rotation to "world-up projected onto tangent". Ridge brushes near the poles will rotate awkwardly. Acceptable for v1; revisit if users complain.
- **Smooth-mode kernel size.** v1 averages only over direct neighbours (5–6 cells). Heavy smoothing under wide brushes requires repeated strokes. Acceptable trade-off for simplicity.
- **Persistence of painter state across browser refresh.** Not in v1. The wizard already does not persist drafts across reload — painting fits the same model.
- **High-tier bake performance.** 192 divisions has not been measured on the target dev box. Hint copy ("~10s per bake") is a placeholder. First benchmark task in the plan will tighten it.

## Out of scope for this sprint

- The 10 Gemini-research shader realism upgrades (rain shadow, continentality mipmap, Holdridge PET, ocean gyres, soil pedogenesis, domain-warped Voronoi ecotones, atmospheric scattering, physically-based snowline, bi-planar mapping, stochastic texturing). These form the next sprint, and will benefit from being validated against painter-shaped terrain.
- User-uploadable brush masks.
- Symmetry/mirror brushes (e.g. paint both hemispheres at once).
- Procedural fill presets ("scatter mountain range", "ring continent").
- Heightmap import from external sources (PNG, Gaea, World Machine).
