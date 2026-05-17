# Gaea-Faithful Erosion Port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the planet erosion to Gaea-grade quality — gentle metre-denominated physics, real mountain ridgelines, flow rivers, natural coastlines, and zoom-dependent (view-tile) detail.

**Architecture:** Two-tier — an always-on macro base bake + a focused detail tile re-baked at finer `dx` on zoom — over four subsystems (S1 scale params, S2 morphology, S3 view-dependent re-bake, S4 Sea-node coastline). See spec `docs/superpowers/specs/2026-05-16-gaea-erosion-port-design.md`.

**Tech Stack:** Rust (`src-tauri`, cargo `--lib` tests), TypeScript + Three.js r0.169 WebGL2, raw-WebGL2 `glPass` GPGPU runner, Vitest (`*.test.ts`), headless real-GPU Playwright harness.

**Phasing (hard rule — this project validates visually between phases):** Implement **Phase S1 fully** (this document, Tasks 1–9), then the controller runs the real-GPU + own-eyes visual gate. Only after S1 passes is the Phase S2 task plan appended/authored (it depends on S1's metre-scale substrate existing and being proven). Same for S4 then S3. Each phase yields a working, visually-testable bake on its own. Phase roadmap is §"Later Phases" below.

**Standing constraints (every task):** work only in worktree `D:\Hackathons\hayba\.claude\worktrees\baking-pipeline-fix` (branch `feat/baking-pipeline`); bare `git commit -m` only (never `-c`, `--no-verify`, `--no-gpg-sign`, `--amend`); never `git worktree/checkout/switch/branch/stash/reset/restore` or `git add -A`; stage only files named in the task; no `Co-Authored-By`/Claude trailer; do NOT stage the pre-existing dirty files (`src-tauri/Cargo.toml`, `src-tauri/gen/schemas/*.json`, `public/erosion_real_inputs.json`, `viewport/bake/hydraulic.glsl.test.ts`, `viewport/bake/hydraulic.glsl.ts` *unless the task explicitly modifies it*). Rust tests: `cd apps/hayba-explorer/src-tauri && cargo test --lib`. TS gate: `cd apps/hayba-explorer && npx tsc --noEmit -p tsconfig.json` and `npx vitest run <file>`.

---

## File Structure (decomposition lock)

| File | Phase | Responsibility |
|---|---|---|
| `src-tauri/src/scale.rs` (new) | S1 | metre-scale model: `WorldScale { terrain_scale, verticality, feature_scale }` + `dx/z_m/zCoeff` derivations + tests |
| `src-tauri/src/bake_equirect.rs` | S1,S3 | attach `WorldScale` to `EquirectInputs`; (S3) windowed rasterise |
| `src-tauri/src/lib.rs` | S1 | `mod scale;` registration |
| `src/viewport/bake/hydraulic.ts` | S1,S2 | `HydraulicConfig` scale fields; remove clamp/uplift defaults; pass scale uniforms |
| `src/viewport/bake/hydraulic.glsl.ts` | S1,S2 | ERODE: replace `maxDeltaB`/`uplift` clamp with metre-denominated incision; (S2) new passes |
| `src/viewport/bake/hydraulic.scale.test.ts` (new) | S1 | Vitest: scale-derivation + config-shape unit tests (headless-pure) |
| `src/viewport/bake/sea.rs` → `src-tauri/src/sea.rs` (new) | S4 | SDF EDT + smooth shore + flood-fill + cliff noise |
| `src/viewport/bake/bands.glsl.ts` (new) | S2 | Laplacian split/recombine ([1,26,26,1]/170) |
| `src/viewport/bake/tileBake.ts` (new) | S3 | camera-settle trigger, window calc, LRU cache, single-flight/abort |
| `src/viewport/bake/debugMaterial.ts` | S3 | macro+tile composite, quintic apron, normals from composited field |
| `src/App.tsx` | S3 | wire tileBake to camera + bake view |

---

## Phase S1 — World-scale parameter model

**Outcome:** erosion strength becomes physical (`dx = terrainScale/resolution`, true metre slope) instead of the ad-hoc `maxDeltaB` clamp + `uplift`. This is what makes it controllable / not "way too strong", and is the substrate every later phase needs. Macro preservation in S1 is interim (gentle params + ocean early-return, exactly as today's ERODE) until S2's band split takes over that role; S1 must not regress the verified ocean/seam/finite invariants.

### Task 1: `scale.rs` — WorldScale model + derivations

**Files:**
- Create: `apps/hayba-explorer/src-tauri/src/scale.rs`
- Modify: `apps/hayba-explorer/src-tauri/src/lib.rs` (add `mod scale;` next to the other `mod` lines)

- [ ] **Step 1: Write the failing test** (append to `scale.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derivations_match_gaea_formulas() {
        // terrain 40_000 m across a 2000-texel grid, 9000 m relief.
        let s = WorldScale { terrain_scale: 40_000.0, verticality: 9_000.0, feature_scale: 2_000.0 };
        let res = 2000.0_f32;
        // dx = terrainScale / resolution
        assert!((s.dx(res) - 20.0).abs() < 1e-3);
        // z_m(h) = h * verticality
        assert!((s.z_m(0.5) - 4_500.0).abs() < 1e-3);
        // zCoeff = terrainScale / (verticality * resolution)
        assert!((s.z_coeff(res) - (40_000.0 / (9_000.0 * 2000.0))).abs() < 1e-9);
        // true slope = Δz_m / dx  (Δh=0.01 over one texel)
        let slope = s.true_slope(0.01, res);
        assert!((slope - (0.01 * 9_000.0 / 20.0)).abs() < 1e-3);
    }

    #[test]
    fn defaults_are_planet_sane() {
        let s = WorldScale::planet_default();
        assert!(s.terrain_scale > 1_000_000.0);   // planet circumference scale
        assert!(s.verticality >= 5_000.0 && s.verticality <= 20_000.0);
        assert!(s.feature_scale > 0.0);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hayba-explorer/src-tauri && cargo test --lib scale::tests`
Expected: FAIL — `WorldScale` undefined / module not found.

- [ ] **Step 3: Write minimal implementation** (top of `scale.rs`)

```rust
//! World-scale parameter model (Gaea §10): makes erosion physical by
//! denominating slope/capacity in metres instead of pixels, so a smaller
//! ground window at fixed resolution resolves finer detail (the S3 zoom
//! mechanism) and strength is a real, controllable quantity.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WorldScale {
    /// Ground width the grid spans, metres.
    pub terrain_scale: f32,
    /// What height 1.0 represents, metres.
    pub verticality: f32,
    /// Target erosion feature wavelength, metres.
    pub feature_scale: f32,
}

impl WorldScale {
    /// Whole-planet macro default: circumference of an Earth-ish radius.
    pub fn planet_default() -> Self {
        WorldScale {
            terrain_scale: 2.0 * std::f32::consts::PI * 6_371_000.0,
            verticality: 9_000.0,
            feature_scale: 2_000.0,
        }
    }
    /// Metres per texel.
    pub fn dx(&self, resolution: f32) -> f32 {
        self.terrain_scale / resolution
    }
    /// Real elevation in metres for a normalised height.
    pub fn z_m(&self, h01: f32) -> f32 {
        h01 * self.verticality
    }
    /// Gaea zCoeff = terrainScale / (verticality * resolution).
    pub fn z_coeff(&self, resolution: f32) -> f32 {
        self.terrain_scale / (self.verticality * resolution)
    }
    /// True dimensionless slope from a normalised-height delta over one texel.
    pub fn true_slope(&self, dh01: f32, resolution: f32) -> f32 {
        self.z_m(dh01) / self.dx(resolution)
    }
}
```

Add `mod scale;` to `lib.rs` beside the other module declarations.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/hayba-explorer/src-tauri && cargo test --lib scale::tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/scale.rs apps/hayba-explorer/src-tauri/src/lib.rs
git commit -m "feat(scale): WorldScale metre-denominated model + derivations"
```

### Task 2: Attach WorldScale to EquirectInputs

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/bake_equirect.rs` (the `EquirectInputs` struct + `bake_inputs_equirect_impl` return; the `#[tauri::command] bake_inputs_equirect`)

- [ ] **Step 1: Write the failing test** (add to the existing `#[cfg(test)] mod tests` in `bake_equirect.rs`)

```rust
#[test]
fn equirect_inputs_carry_world_scale() {
    let draft = small_test_draft(); // existing helper used by spatial_eq_bruteforce_*
    let out = bake_inputs_equirect_impl(&draft, 64, 32);
    // planet macro default until S3 overrides per-tile
    assert!(out.scale.terrain_scale > 1_000_000.0);
    assert!((out.scale.dx(64.0) - out.scale.terrain_scale / 64.0).abs() < 1e-1);
}
```

(If `small_test_draft()` is not the exact existing helper name, use whatever the adjacent `spatial_eq_bruteforce_*` tests already construct — reuse it, do not invent a new fixture.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hayba-explorer/src-tauri && cargo test --lib equirect_inputs_carry_world_scale`
Expected: FAIL — `out.scale` field missing.

- [ ] **Step 3: Write minimal implementation**

In `bake_equirect.rs`: add `use crate::scale::WorldScale;`. Add `pub scale: WorldScale,` to `struct EquirectInputs`. In `bake_inputs_equirect_impl`, set `scale: WorldScale::planet_default()` in the returned struct. Keep `#[derive(Serialize)]` working (WorldScale is `Serialize`). No other logic changes — height/precip arrays untouched (the `spatial_eq_bruteforce_*` tests must still pass byte-identically).

- [ ] **Step 4: Run tests to verify pass**

Run: `cd apps/hayba-explorer/src-tauri && cargo test --lib`
Expected: PASS — new test green, all existing `spatial_eq_bruteforce_*` / continuity / determinism tests still green (height/precip unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/bake_equirect.rs
git commit -m "feat(bake): carry WorldScale on EquirectInputs (planet default)"
```

### Task 3: TS — EquirectInputs type + HydraulicConfig scale fields

**Files:**
- Modify: `apps/hayba-explorer/src/App.tsx` (the `EquirectInputs` TS interface — locate it via the `invoke<EquirectInputs>("bake_inputs_equirect"...)` call site)
- Modify: `apps/hayba-explorer/src/viewport/bake/hydraulic.ts` (`HydraulicConfig`, `DEFAULT_HYDRAULIC`)
- Create: `apps/hayba-explorer/src/viewport/bake/hydraulic.scale.test.ts`

- [ ] **Step 1: Write the failing test** (`hydraulic.scale.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { DEFAULT_HYDRAULIC } from "./hydraulic";

describe("S1 scale config", () => {
  it("DEFAULT_HYDRAULIC drops the ad-hoc clamp/uplift and adds scale knobs", () => {
    // The metre-denominated model replaces the maxDeltaB clamp + uplift.
    expect("maxDeltaB" in DEFAULT_HYDRAULIC).toBe(false);
    expect("uplift" in DEFAULT_HYDRAULIC).toBe(false);
    // New physical strength knobs (dimensionless, integrated over duration).
    expect(typeof DEFAULT_HYDRAULIC.strength).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.downcutting).toBe("number");
    expect(DEFAULT_HYDRAULIC.strength).toBeGreaterThan(0);
    expect(DEFAULT_HYDRAULIC.strength).toBeLessThan(0.2); // "not way too strong"
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hayba-explorer && npx vitest run src/viewport/bake/hydraulic.scale.test.ts`
Expected: FAIL — `maxDeltaB`/`uplift` still present, `strength`/`downcutting` undefined.

- [ ] **Step 3: Write minimal implementation**

In `hydraulic.ts`: in `HydraulicConfig` remove `uplift` and `maxDeltaB`; add `strength: number;` (erosion/thermal rate, dimensionless, integrated over `steps`) and `downcutting: number;` (vertical incision rate). In `DEFAULT_HYDRAULIC` remove `uplift`/`maxDeltaB`, add `strength: 0.04`, `downcutting: 0.25`. Update the `DEFAULT_HYDRAULIC` doc comment: the macro-preservation mechanism is now metre-denominated gentle physics + ocean early-return (interim; S2 band split takes over) — delete the now-obsolete "steps*maxDeltaB bound" paragraph and state the new model in 2–3 lines.
In `App.tsx`: add `scale: { terrain_scale: number; verticality: number; feature_scale: number }` to the `EquirectInputs` interface (snake_case to match serde).

- [ ] **Step 4: Run test + tsc to verify pass**

Run: `cd apps/hayba-explorer && npx vitest run src/viewport/bake/hydraulic.scale.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: vitest PASS; tsc exits 0 (fix any `maxDeltaB`/`uplift` references the removal surfaced — see Task 4).

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/viewport/bake/hydraulic.ts apps/hayba-explorer/src/viewport/bake/hydraulic.scale.test.ts apps/hayba-explorer/src/App.tsx
git commit -m "feat(hydraulic): scale knobs replace maxDeltaB/uplift in config"
```

### Task 4: ERODE pass — metre-denominated incision (remove the clamp)

**Files:**
- Modify: `apps/hayba-explorer/src/viewport/bake/hydraulic.glsl.ts` (`ERODE_FRAG` only)
- Modify: `apps/hayba-explorer/src/viewport/bake/hydraulic.ts` (`runHydraulicBake` ERODE uniforms block, lines ~315–333)

**Context for the implementer:** Read the current `ERODE_FRAG` in `hydraulic.glsl.ts` and the ERODE uniforms object in `hydraulic.ts` (~line 315) first. Today ERODE clamps per-step bedrock change to `±uMaxDeltaB` and adds `uUplift` on land. Replace that mechanism: compute the **true slope** with `slope = (Δz_m)/dx` where `dz_m = Δh * uVerticality` and `dx = uTerrainScale / uResX` (uResX = grid width in texels = `uGrid.x`), then drive capacity/incision by `uStrength` and `uDowncutting` against that physical slope, integrated by `uDt` (per the spec §4/§5.1 capacity rule). Delete `uMaxDeltaB` and `uUplift` uniform declarations and their use; keep the ocean early-return and pole damp **unchanged** (ocean invariant). One `uniform <type> <name>;` per line (glPass parses these), no backticks.

- [ ] **Step 1: Write the failing test** (extend `hydraulic.scale.test.ts`)

```ts
import { ERODE_FRAG } from "./hydraulic.glsl";

it("ERODE_FRAG is metre-denominated, no clamp/uplift uniforms", () => {
  expect(ERODE_FRAG).not.toMatch(/uMaxDeltaB/);
  expect(ERODE_FRAG).not.toMatch(/uUplift/);
  expect(ERODE_FRAG).toMatch(/uniform float uStrength;/);
  expect(ERODE_FRAG).toMatch(/uniform float uDowncutting;/);
  expect(ERODE_FRAG).toMatch(/uniform float uVerticality;/);
  expect(ERODE_FRAG).toMatch(/uniform float uTerrainScale;/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/hayba-explorer && npx vitest run src/viewport/bake/hydraulic.scale.test.ts`
Expected: FAIL — still has `uMaxDeltaB`/`uUplift`, missing new uniforms.

- [ ] **Step 3: Write minimal implementation**

Edit `ERODE_FRAG` per the Context above (metre-true-slope capacity/incision, `uStrength`/`uDowncutting`/`uVerticality`/`uTerrainScale` uniforms, no clamp/uplift, ocean/pole untouched). In `hydraulic.ts` ERODE uniforms object: drop `uMaxDeltaB`/`uUplift`; add `uStrength: u(cfg.strength)`, `uDowncutting: u(cfg.downcutting)`, `uVerticality: u(cfg.scale.verticality)`, `uTerrainScale: u(cfg.scale.terrainScale)` — and thread a `scale: {terrainScale,verticality,featureScale}` field onto `HydraulicConfig` (add to interface + `DEFAULT_HYDRAULIC` using the planet defaults: `terrainScale: 2*Math.PI*6371000, verticality: 9000, featureScale: 2000`) and update the `runHydraulicBake` callers to pass `inp.scale` through (map snake_case→camelCase at the App.tsx call site). Update the ERODE per-pass comment in `hydraulic.ts` to the new uniform list.

- [ ] **Step 4: Run tests + tsc**

Run: `cd apps/hayba-explorer && npx vitest run src/viewport/bake/hydraulic.scale.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: vitest PASS; tsc 0.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/viewport/bake/hydraulic.glsl.ts apps/hayba-explorer/src/viewport/bake/hydraulic.ts apps/hayba-explorer/src/viewport/bake/hydraulic.scale.test.ts apps/hayba-explorer/src/App.tsx
git commit -m "feat(erode): metre-denominated incision replaces per-step clamp"
```

### Task 5: Rust gate

- [ ] **Step 1:** Run `cd apps/hayba-explorer/src-tauri && cargo test --lib`. Expected: ALL pass (scale tests + unchanged `spatial_eq_bruteforce_*`/continuity/determinism). If a height/precip test changed, the rasterise was wrongly touched — revert that, only `scale` is additive.

### Task 6: TS gate

- [ ] **Step 1:** Run `cd apps/hayba-explorer && npx tsc --noEmit -p tsconfig.json && npx vitest run`. Expected: tsc 0; all vitest green.

### Task 7: Headless real-GPU numeric verification

**Files:** none committed (uses the existing `__headless_harness__.ts` real-input path; revert any temporary helper).

- [ ] **Step 1:** Via the Playwright MCP over the Vite dev server (real GPU), run the existing real-input hydraulic bake with `DEFAULT_HYDRAULIC` (now S1 metre-scale). Assert verbatim: `nan==0,inf==0`, ocean preserved (`oceanLost==0`, flag kept), land erodes, `seamRatio~0`, finite minB/maxB. Record `landMaxAbsDelta` — it MUST be **substantially lower** than the pre-S1 0.196 (the whole point: gentler). If land no longer erodes at all, `uStrength` is too low — note it for the visual gate, do not block.

### Task 8: Controller visual gate (real GPU, own eyes)

- [ ] **Step 1:** Drive the real app (Compose → Load Earth → Bake) on the real GPU; screenshot front + zoom. Controller inspects: erosion visibly **gentler** (not the over-eroded look), continents preserved, ocean blue, no NaN/seam, no GL errors. This is the authoritative S1 gate. If too strong/too weak, tune `strength`/`downcutting` in `DEFAULT_HYDRAULIC` and re-gate (tuning-only commits).

### Task 9: Phase S1 close-out

- [ ] **Step 1:** Update memory `project_baking_pipeline_redesign.md`: S1 (metre-scale model) landed, clamp/uplift removed, gentler verified. Commit only that memory file is N/A (memory dir is outside the repo — just write it, no git).
- [ ] **Step 2:** Append the Phase S2 detailed task plan to this file (authored now that S1 exists), then proceed.

### Task 10: Rasterizer performance — parallelize (rayon) + non-blocking + streamed progress

**Why:** the continuous IDW+FBM rasteriser (`bake_inputs_equirect_impl`, commit `03fc40f7`) is single-threaded → ~tens of seconds at 2048×1024, pegging one core and freezing the webview during "Rasterising…". The GPU sim already streams; this CPU stage does not. User-reported blocker.

**Files:** `apps/hayba-explorer/src-tauri/src/bake_equirect.rs`; `apps/hayba-explorer/src-tauri/Cargo.toml` (rayon dep — NOTE: Cargo.toml is a pre-existing-dirty protected file; this task is the *one* sanctioned exception that may stage it, and ONLY the rayon dependency line).

- [ ] **Step 1: Failing determinism test** — add to `bake_equirect.rs` tests: a `rayon`-parallel `bake_inputs_equirect_impl` must be **byte-identical** to a serial reference on the `earthish_draft()` fixture at 256×128 (parallelism must not change output — the per-texel function is pure; parallelize the outer row loop, each row writes a disjoint slice).

```rust
#[test]
fn parallel_rasterise_is_byte_identical_to_serial() {
    let d = test_support::earthish_draft();
    let par = bake_inputs_equirect_impl(&d, 256, 128);
    let ser = bake_inputs_equirect_serial(&d, 256, 128); // kept #[cfg(test)] serial ref
    assert_eq!(par.height, ser.height);
    assert_eq!(par.precip, ser.precip);
}
```

- [ ] **Step 2:** Run it — FAIL (no parallel impl / no serial ref yet).
- [ ] **Step 3:** Add `rayon` to `Cargo.toml` (workspace-consistent version). Parallelise the outer latitude-row loop with `par_chunks_mut` over the `height`/`precip` output slices (one chunk = one row of `w`), capturing `&CellGrid`/`&cells` by shared ref (read-only — `Sync`). Keep a `#[cfg(test)] fn bake_inputs_equirect_serial` as the byte-equal oracle. The `CellGrid` query is read-only and order-independent → output is deterministic regardless of thread scheduling.
- [ ] **Step 4:** Run `cargo test --lib` — the new test + all existing `spatial_eq_bruteforce_*`/continuity/determinism PASS (parallel ≡ serial ≡ prior output).
- [ ] **Step 5: Walltime assertion** — extend the existing `rasterizer_walltime_*` test (or add one) asserting 2048×1024 completes in `< 4 s` in `--release` (was ~tens of s single-thread; rayon across N cores must beat this comfortably — set the bound from the measured release number, non-flaky).
- [ ] **Step 6: Non-blocking** — confirm the `#[tauri::command] bake_inputs_equirect` does not block the webview UI thread: it must be an `async` command (Tauri runs it on its async runtime / `spawn_blocking`), and `handleDebugBake` already `await`s it. If it is a sync command on the main thread, convert to `async fn` + `tauri::async_runtime::spawn_blocking`. (Inspect `bake_equirect.rs` + the command registration; no behaviour change, only threading.)
- [ ] **Step 7: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/bake_equirect.rs apps/hayba-explorer/src-tauri/Cargo.toml
git commit -m "perf(bake): parallelise equirect rasteriser (rayon), keep off UI thread"
```

(Run order: execute Task 10 immediately after the S1 visual gate, before Phase S2 — a frozen page makes every later visual gate unreliable.)

### Tracked follow-up (not S1): ocean "circle/disc" rasterise artefacts

**Observed at S1 gate (user, Image #31):** deep ocean shows overlapping circular disc patches — the k=6 IDW blend (`bake_equirect.rs`, commit `03fc40f7`) renders each painted Goldberg cell's influence as a soft disc, so cell footprints read as circles. Continents/erosion unaffected; cosmetic on the seafloor.
**Root cause:** nearest-k inverse-distance weighting with hard k cutoff → visible per-cell footprints. Higher texel resolution does NOT fix it (upsamples the same discs).
**Empirical finding (user, 2026-05-17):** raising the **Compose painter mesh resolution** (more, smaller Goldberg cells) makes the discs vanish — higher texelization fidelity, no circle artefacts. Confirms the mechanism: artefact size ∝ painted-cell footprint size; denser cells ⇒ sub-visual footprints. So the lever is partly UX/resolution, not only kernel. **User asked (2026-05-17) for a very high tier (~1M cells).** Feasibility: the bake/rasterise side is cheap now (rayon-parallel + O(1) `CellGrid`); the blocker is the painter UX — `syncFromPainter` resyncs the WHOLE vertex buffer per pointer-move, which janks at ~2M tris. A 1M-cell tier needs **incremental/partial mesh buffer updates** (only touched cells) + a higher `divisions` option + memory budget; Rust grid-gen/kd-tree/adjacency are one-time O(n)/O(n log n) (fine). Treat as its own task, NOT mid-S2.
**Fix path (defer — Phase S4 boundary):** evaluate two complementary routes — (a) **raise the default Compose painter resolution** (simplest, user-validated; cost: more cells ⇒ heavier rasterise + memory — largely absorbed by Task 10's rayon parallelisation and bounded by S3 tiling); (b) replace the hard-k IDW with a smoother kernel (Gaussian angular falloff / larger k / natural-neighbour) so even low-res painting looks clean; plus S4's Sea-node SDF shelf-smoothing for deep ocean. Add a Rust test: adjacent-texel curvature/Laplacian variance over a flat painted region drops below an artefact threshold (verify both the higher-res-default path and the smoother-kernel path satisfy it). Do NOT do this during S1/S2; revisit when authoring S4.

### Tracked follow-up (not S1): poles not perfectly clean

**Observed at S1 gate (user):** the polar regions are not perfectly clean (minor — equirect lat→texel convergence + `poleBand` damp; not a blowup). Acceptable for now per user.
**Fix path (defer):** revisit pole handling when authoring S3 (windowed tiles never include the poles at zoom, so this only affects the global macro view) — options: stronger `poleBand` taper, polar-cap mask, or a small cosine-lat area weighting in the rasterise/erode. Add a headless assert that polar rows stay finite and within macro-band bounds. Do NOT address during S1/S2.

---

## Later Phases (authored at each phase boundary, after the prior visual gate)

Each is its own working/testable increment; full bite-sized TDD tasks are written when the phase starts (the spec already fixes the algorithms/formulas, so this is expansion, not redesign).

### Phase S2 — Erosion morphology  *(spec §5; authored 2026-05-17 from the S2 dossier, at the S2 boundary)*

**Execution order is RE-ORDERED from S2.1→S2.5 for de-risking** (the spec/dossier fix all algorithms; this is sequencing only): **S2.2 first** (anisotropic thermal = the ridgelines the user most wants, self-contained, no RT-allocation surgery, fastest visible win) → **S2.4** (detailMask: tiny, gates ridge/relief to mountains per the user's "mask at mountain heights") → **S2.3** (flow rivers) → **S2.1** (3-class sediment, needs extra RTs) → **S2.5** (Laplacian band split, most invasive; becomes the clamp-free macro-preservation). S1's interim macro-preservation (gentle metre params + ocean early-return, visually gate-passed) holds until S2.5, so S2.5 is not a blocker for the earlier wins.

**Test surface (every S2 task):** GPU passes are not Rust-unit-testable, so each task's automated gate = a **Vitest GLSL-contract test** (the `*.glsl.ts` string declares exactly the new uniforms, contains the key formula token, drops removed ones — same pattern as S1's `hydraulic.scale.test.ts`) + `tsc` + `cargo test --lib` still 55/0 + `npx vitest run`. The real correctness/quality gate is the **controller headless real-GPU numeric assert + own-eyes visual** at the end of S2 (gentle, ridged, rivered, mountain-gated; ocean/seam/finite invariants intact). Constraints header applies (bare commit, stage only named files, no trailer; `hydraulic.glsl.ts` IS modified by these tasks so it is staged here despite the pre-existing-dirty note — verify `git diff --cached` shows only the intended pass additions).

#### Task S2.2 — Anisotropic thermal/talus (the ridgeline maker)
**Files:** `src/viewport/bake/hydraulic.glsl.ts` (replace `THERMAL_FRAG`), `src/viewport/bake/hydraulic.ts` (THERMAL uniforms block + `HydraulicConfig`/`DEFAULT_HYDRAULIC`: add `talusAngle` (deg, default 32), `anisotropy` (0–1, default 0.5), `sedimentRemoval` (0–1, default 0.0); the existing `kt`/`tanTalus` are superseded — replace `tanTalus` usage with `tan(talusAngle)` computed in TS and passed, keep `kt`→rename to/keep as `uStrengthThermal`), `src/viewport/bake/hydraulic.scale.test.ts` (add S2.2 contract test).
- [ ] **Step 1 (failing test):** in `hydraulic.scale.test.ts` assert `THERMAL_FRAG` matches `/uniform float uTanTalus;/`, `/uniform float uStrengthThermal;/`, `/uniform float uAnisotropy;/`, `/uniform float uSedimentRemoval;/`, `/uniform float uVerticality;/`, `/uniform float uTerrainScale;/`, and contains the anisotropy token `1.0 + uAnisotropy *`; and does NOT match `/uTanTalus[^;]*\n[^;]*uKt\b/` legacy combos (i.e. old `uKt`/`uTanTalus`-only form gone). Run `npx vitest run src/viewport/bake/hydraulic.scale.test.ts` → FAIL.
- [ ] **Step 2 (implement GLSL):** rewrite `THERMAL_FRAG` per dossier S2.2: 8-neighbour talus on `A.r`; true **metre** slope `s = (z_m_self - z_m_nbr)/dist_m` with `z_m = h*uVerticality`, `dist_m = (cardinal?1:sqrt2) * uTerrainScale/uGrid.x`; if `s > tan(uTanTalus_radians)` (pass `uTanTalus` already as `tan(angle)` from TS) → `excess = (s - tanTalus)*dist_m*0.5`; `grad = vec2(aE.r-aW.r, aN.r-aS.r)*0.5`; `dirBias = dot(normalize(offset), normalize(grad+1e-6))`; `effStrength = uStrengthThermal*(1.0 + uAnisotropy*dirBias)`; `move = excess*effStrength*uDt*wLat` (reuse existing `wLatOf` pole damp); `b -= move`; redistribute `move*(1-uSedimentRemoval)` to the lower neighbour direction (single steepest-lower neighbour to keep it a 1-pass gather: subtract from self, the deposition is implicit next step — match dossier's per-cell gather form: sum contributions FROM higher neighbours INTO self and TO lower, computed as a gather so the pass stays single-RT ping-pong A→A). **Ocean early-return byte-identical to current THERMAL** (preserve `a.a`, zero nothing that the old pass didn't). One `uniform <type> <name>;` per line, no backticks.
- [ ] **Step 3:** wire `hydraulic.ts`: THERMAL uniforms object passes exactly the new decls (drop `uKt`/`uTanTalus`-as-config, add the six); `DEFAULT_HYDRAULIC` add `talusAngle:32, anisotropy:0.5, sedimentRemoval:0.0`, compute `uTanTalus = Math.tan(talusAngle*Math.PI/180)` at the call site; keep `thermalEvery` cadence. Update the THERMAL per-pass comment.
- [ ] **Step 4 (gates):** `npx vitest run src/viewport/bake/hydraulic.scale.test.ts` PASS; `npx tsc --noEmit -p tsconfig.json` exit 0; `cd src-tauri && cargo test --lib` still 55/0 (Rust untouched).
- [ ] **Step 5 (commit):** `git add apps/hayba-explorer/src/viewport/bake/hydraulic.glsl.ts apps/hayba-explorer/src/viewport/bake/hydraulic.ts apps/hayba-explorer/src/viewport/bake/hydraulic.scale.test.ts` ; `git commit -m "feat(s2.2): anisotropic thermal/talus pass — mountain ridgelines"`

#### Task S2.4 — Elevation/slope detailMask (gate relief to mountains)
**Files:** `hydraulic.glsl.ts` (new `DETAIL_MASK_FRAG` one-time pass; multiply the relief/erosion contributions by the sampled mask in `ERODE_FRAG` + `THERMAL_FRAG`), `hydraulic.ts` (allocate a one-time `detailMask` RT, run `DETAIL_MASK_FRAG` once pre-loop, bind it to ERODE/THERMAL; config `elevFloor:0.2, elevMid:0.5, slopeFloor:0.05, slopeMid:0.5` as fractions/slope), `hydraulic.scale.test.ts`.
- [ ] **Step 1 (failing test):** assert a `DETAIL_MASK_FRAG` export exists and contains `smoothstep` for both an elevation gate and a slope gate and writes a single-channel mask; assert `ERODE_FRAG`/`THERMAL_FRAG` now sample `uDetailMask`. FAIL first.
- [ ] **Step 2:** implement `DETAIL_MASK_FRAG` per dossier S2.4: `elevGate=smoothstep(uElevFloor*uVerticality, uElevMid*uVerticality, z_m)`, `slopeGate=smoothstep(uSlopeFloor,uSlopeMid, slope)`, `detail=clamp(elevGate*slopeGate,0,1)`, ocean→0; bind `uDetailMask` into ERODE (gate the relief/incision strength) and THERMAL (gate `effStrength`).
- [ ] **Step 3–5:** wire one-time pass in `hydraulic.ts` (compute once before the step loop, reuse every step — do NOT recompute per step), gates green, commit `feat(s2.4): elevation/slope detailMask gates relief to high steep terrain`.

#### Task S2.3 — Flow-mask river incision
**Files:** `hydraulic.glsl.ts` (new `CARVE_RIVERS_FRAG`), `hydraulic.ts` (insert after WATER, before ERODE; config `riverThreshold0:0.001, riverThreshold1:0.01, riverDepth:0.005`), `hydraulic.scale.test.ts`.
- [ ] **Steps:** failing contract test (`CARVE_RIVERS_FRAG` declares `uRiverThreshold0/1`,`uRiverDepth`,`uDowncutting`, uses `smoothstep` on flux magnitude) → implement per dossier S2.3 (`flowMag=length(F)`, `river=smoothstep(t0,t1,flowMag)`, `b -= uRiverDepth*river*uDowncutting*detailMask`, ocean early-return) → wire pass order (after WATER, before ERODE) → gates → commit `feat(s2.3): flow-mask river incision`.

#### Task S2.1 — Three-class sediment hydraulic
**Files:** `hydraulic.glsl.ts` (`ERODE_FRAG`→multi-class, `ADVECT_FRAG`→3 loads), `hydraulic.ts` (allocate `S0/S1/S2` RGBA32F ping-pong RTs per dossier "Option B"; SEED them to 0; per-class config: `suspended{amount:1.0,angle:24}`, `mixed{0.0,15}`, `coarse{0.0,10}`), `pingpong.ts` if the RT-set helper needs the extra channels, `hydraulic.scale.test.ts`.
- [ ] **Steps:** failing contract test (ERODE declares per-class `uStrength*`/`uAngle*`, `uS0..uS2`; ADVECT advects 3 loads) → implement Option-B separate-RT 3-class per dossier S2.1 (`shear=pow(flowAccum,0.5)*pow(slope,1)`, per-class `cap=strength*shear*angleFactor`, deposit/erode, advect each) preserving the ocean/finite invariants and S1 metre-slope → wire RT alloc + SEED + swap + dispose in `runHydraulicBake` (mirror the A/F discipline; +3×VRAM noted) → gates (incl. cargo 55/0) → commit `feat(s2.1): three-class sediment hydraulic transport`.

#### Task S2.5 — Laplacian band split (clamp-free macro preservation)
**Files:** `src/viewport/bake/bands.glsl.ts` (new: `BAND_DOWNSAMPLE/UPSAMPLE/EXTRACT/RECOMBINE` per dossier S2.5 `[1,26,26,1]/170`), `hydraulic.ts` (one-time split before loop → run S2.1–S2.4 erosion on the detail band → recombine after loop; alloc `RTmacro`/`RTdetail`), `bands.test.ts` (new Vitest), `hydraulic.scale.test.ts`.
- [ ] **Steps:** failing test — **macro round-trip identity**: `recombine(macro, extract(A - upsample(downsample(A)))) ≈ A` to f32 epsilon with ZERO erosion steps (the band split must be lossless when nothing erodes) — plus contract tests on the 4 frags → implement per dossier S2.5 (separable [1,26,26,1]/170; erosion passes read/write `RTdetail`, `RTmacro` frozen; recombine preserves `a.g/b/a` and the ocean sign from the macro band) → wire pre/post-loop in `runHydraulicBake` → gates → commit `feat(s2.5): Laplacian band split — clamp-free macro preservation`.

- [ ] **S2 phase gate (controller):** headless real-GPU numeric (ocean preserved, finite, seam~0, ridge-presence curvature stat > baseline) + **own-eyes visual on the real GPU**: gentle, **real mountain ridgelines**, dendritic rivers, detail concentrated on mountains/spared on ocean+flatland, macro silhouette preserved with NO clamp (S2.5), no GL errors. Then update memory + author Phase S4.

### Phase S4 — Sea-node coastline  *(spec §7)*
- **S4.1** `sea.rs`: separable parabolic Euclidean distance transform; Rust test vs brute-force EDT.
- **S4.2** smoothMin/smoothMax cubic + quintic `fade` — Rust tests vs hand-computed values (formulas in spec §7).
- **S4.3** Shore-profile blend over metre `shoreSize/shoreHeight` (scale-aware via S1); flood-fill EdgeFill coastal vs basin; optional cliff value-noise.
- **S4.4** Wire S4 before S1/S2 in `bake_equirect.rs`, on macro **and** per tile (scale-aware); ocean-sign invariant test.
- Phase gate: natural shelf/beach/cliff coastlines, ocean sign preserved, seam continuous.

### Phase S3 — View-dependent re-bake  *(spec §6)*
- **S3.1** `bake_inputs_equirect_window(draft,latMin,latMax,lonMin,lonMax,w,h)`; Rust test: full window ≡ global byte-equal; per-tile `WorldScale.terrain_scale` = window arc width.
- **S3.2** `tileBake.ts`: camera-settle (debounced) trigger, visible lat/lon AABB+apron, target res for `dx≈featureScale/k`, LRU cache (quantised AABB+res), invalidate on draft/param change.
- **S3.3** Single-flight + abort/supersede; macro base stays live; chunked-yield sim. Stress: rapid-pan ⇒ ≤1 in-flight, no frame lock.
- **S3.4** Shader composite in `debugMaterial.ts`: macro everywhere + tile where covered, **quintic (C1) apron feather**, **normals from the single composited field**; seam metric on the normal field.
- **S3.5** Wire into `App.tsx` (camera hook, bake view); tile-fail ⇒ macro fallback.
- Phase gate: zoomed-out clean (no noisy texels), zoom-in reveals simulated micro ridges, seam invisible incl. lighting, no stalls.

---

## Self-Review

**Spec coverage:** S1 §4 → Tasks 1–4 (model, carry, config, ERODE physics) + gates 5–8. S2 §5 / S4 §7 / S3 §6 → Later-Phases outline, expanded at each boundary (deliberate — no-placeholder rule: their exact code depends on S1 being built+validated first). Invariants §9 (ocean sign, seam, finite, no overlay regression) → Tasks 7/8 assertions. Testing §10 → Rust `cargo test --lib`, Vitest, headless real-GPU, controller visual. File table §11 → File-Structure lock above. No spec section unmapped.

**Placeholder scan:** S1 tasks contain concrete code/tests/commands/expected output. Later-Phases are intentionally outlines, not fake code — flagged as authored-at-boundary per the phasing rule, not "TODO/fill-in".

**Type consistency:** `WorldScale{terrain_scale,verticality,feature_scale}` (Rust snake_case, serde) ↔ TS `scale.terrain_scale` on `EquirectInputs`, mapped to camelCase `HydraulicConfig.scale.{terrainScale,verticality,featureScale}` at the App.tsx call site (Task 3/4 consistent). ERODE uniforms `uStrength/uDowncutting/uVerticality/uTerrainScale` named identically in glsl test, glsl frag, and `hydraulic.ts` uniforms block (Task 4). `DEFAULT_HYDRAULIC` loses `maxDeltaB/uplift`, gains `strength/downcutting/scale` consistently across Tasks 3–4.
