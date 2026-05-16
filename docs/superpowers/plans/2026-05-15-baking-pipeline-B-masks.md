# Baking Pipeline — Subsystem B: Mask Library — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** From Subsystem A's eroded equirect `h_final`, compute the entire mask stack **once** (geometry, hydrology, climate, classification/transition, pattern-break, per-biome brushes), bake all multi-octave noise + the ~5–6px micro-bleed into MRT textures, and expose everything behind the `sampleField(lonlat) → { height, masks… }` contract.

**Architecture:** A pure-Rust CPU oracle (ports the proven `climate.rs` math into the equirect domain; reuses `hydrology.rs` for drainage) is the TDD backbone; GPU passes are ported from it and validated by CPU-parity + visual (same model as Plan A). The ALU Bake Enforcement invariant (spec §6) is normative: **all** multi-octave `fbm`/`ridged`/`worley`/`domainWarp` and the micro-bleed are computed here at bake time; the live shader (Subsystem C) does only O(1) taps.

**Tech Stack:** Same as Plan A (Rust `cargo test --lib`; TS `npx tsx`; Three.js WebGL2 ping-pong/MRT GLSL). **Conventions: identical to Plan A** (read its "Conventions" block — Rust/TS test harness, commit rules, determinism, no `git add -A`, no co-author trailer).

**Spec:** `docs/superpowers/specs/2026-05-15-baking-pipeline-redesign-design.md` §6 (+ the §6 Flow-Accumulation HARDENING + ALU Bake Enforcement NORMATIVE blocks), §3 (P2 `C_proxy`), §11, §12 (risks 5,8).

**Depends on:** Plan A complete & visually signed off (provides `h_final` equirect Float texture + the `erosion::*` Rust modules + `viewport/bake/pingpong.ts`, `passes.glsl.ts`).

---

## Mask catalog (the contract — every item is a baked texture channel)

Packed into MRT RGBA32F targets, ≤8 textures, documented packing in `masks/layout.rs`/`.ts`:

1. **Geometry:** `height`(=h_final), `slope`, `normalXYZ`, `curvature`, `AO`, `flowAccumSDF`, `windExposure`.
2. **Hydrology:** `drainage`, `river`, `deposition`, `wetness`, `shorelineSDF`, `ridgeValley`, `localRelief`(=h_final−heightOfNearestChannel, the SatMap LUT-X).
3. **Climate (ported from `climate.rs`, all from `h_final`):** `insolation`, `baseTemp`(continentality from final elev), `temperature`, `distToOcean`(seam-wrapped JFA), `precip`(orographic+downwind), `oceanCurrentDT`(domain-warped). **`C_proxy` is NOT a mask channel** — it is the *pre-erosion* P2 product computed from `h0` by the isolated `compute_cproxy(h0)` (B6b), consumed by erosion before this stage exists.
4. **Classification/transition:** `biomePrimary`, `biomeSecondary`, `blendWeight` (NOT a 10-slot weight vector — review C3: enables 2-tap `sampler2DArray` shading, no dynamic sampler indexing), `sobelFrontier`, `noisePerturbedFrontier`.
5. **Pattern-break (baked):** `macroVariation`, `mesoDetail`, `edgeBreak`, `microCohesion`.
6. **Per-biome brushes (baked):** `rockExposure`(=slope·curvature), `dune`, `vegetationPatch`.

---

## File Structure

**New — Rust:** `src-tauri/src/masks/mod.rs` (catalog, `MaskConfig`, `compute_masks_cpu`), `masks/geometry.rs`, `masks/hydrology.rs` (drainage/flow-accum-SDF/shoreline/localRelief), `masks/climate_eq.rs` (equirect port of `climate.rs` math; **reuses** `crate::climate` formulas), `masks/transition.rs` (sobel/frontier/noise-perturb), `masks/patterns.rs` (macro/meso/edgeBreak/microCohesion + per-biome brushes), `masks/layout.rs` (MRT packing constants).
**Modified — Rust:** `lib.rs` (`mod masks;` + register `wizard::bake_masks_v2`), `wizard.rs` (`bake_masks_v2` command).
**New — TS:** `src/viewport/bake/masksPipeline.ts` (GPU MRT pass orchestrator → mask texture set), `src/viewport/bake/masks.glsl.ts` (GLSL ports), `src/viewport/bake/sampleField.ts` (the §9 interface: wraps the mask textures; Phase-1 = global equirect, VT stub).
**Modified — TS:** `App.tsx` (chain A→B in the bake action), `src/viewport/bake/parity.ts` (extend to mask parity).

---

## Phase B0 — CPU oracle: geometry & hydrology masks

### Task B1: `MaskConfig` + module entry + MRT layout

**Files:** Create `masks/mod.rs`, `masks/layout.rs`; Modify `lib.rs` (`mod masks;`).

- [ ] **Step 1: Failing test** (`mod.rs`):

```rust
#[cfg(test)]
mod tests { use super::*;
  #[test] fn layout_packs_all_channels_disjoint_with_per_target_formats() {
    let l = layout::MASK_LAYOUT;
    assert!(l.is_disjoint(), "no two masks share a (texture,channel)");
    assert!(l.contains("localRelief") && l.contains("microCohesion"));
    // VRAM-bomb guard (review B1): NOT blanket RGBA32F.
    // 8K * sum(bytes-per-target) MUST stay under a sane budget.
    let bytes: usize = l.targets().map(|t| t.format.bytes_per_texel()).sum();
    let vram = 8192usize * 4096 * bytes;
    assert!(vram < 1_600_000_000, "mask VRAM {vram} must stay < ~1.6 GB");
    // unorm masks must be RGBA8, not 32F
    assert_eq!(l.format_of("biomePrimary"), Fmt::RGBA8);
    assert_eq!(l.format_of("wetness"),      Fmt::RGBA8);
    // geometric/SDF may be 16F; nothing is RGBA32F unless justified
    assert!(l.targets().all(|t| t.format != Fmt::RGBA32F || t.justified));
  }
  #[test] fn cproxy_is_not_a_baked_mask_channel() {
    // C_proxy is computed pre-erosion from h0 (spec §5.3) — it is NOT a
    // post-erosion mask. It must NOT appear in the mask layout.
    assert!(!layout::MASK_LAYOUT.contains("Cproxy"));
  }
}
```

- [ ] **Step 2:** `cargo test --lib masks::tests` → FAIL.
- [ ] **Step 3:** Implement `MaskConfig` (`#[serde(default)]`: `equirect_w:8192, equirect_h:4096, micro_bleed_px:5, cproxy_res:256, seed`), `Fmt { RGBA8, RGBA16F, RGBA32F }` with `bytes_per_texel()`, and `layout.rs::MASK_LAYOUT` = a static table mapping each catalog name → `(texture_index, channel, Fmt)`. **Per-target format assignment is NORMATIVE (review B1 — blanket 8×RGBA32F@8K = 4.3 GB ⇒ WebGL context loss):** RGBA8 for unorm masks (biomePrimary/biomeSecondary/blendWeight, wetness, variations, baseTemp, frontier…); RGBA16F only for geometric/SDF/AO/normal; RGBA32F only with a `justified` flag. `C_proxy` is **not** in this layout (it's the pre-erosion P2 product, §5.3 — see B6).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/mod.rs apps/hayba-explorer/src-tauri/src/masks/layout.rs apps/hayba-explorer/src-tauri/src/lib.rs` → `feat(masks): MaskConfig + disjoint MRT layout for full catalog`.

### Task B2: Geometry masks (slope, normal, curvature, AO)

**Files:** Create `masks/geometry.rs`; Modify `masks/mod.rs`.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn slope_normal_curvature_on_a_known_ramp() {
    let (w,h)=(16,8); let mut hf=vec![0.0f32; (w*h) as usize];
    for y in 0..h { for x in 0..w { hf[(y*w+x) as usize]= x as f32 * 0.1; }} // east ramp
    let g = geometry::compute(&hf, w, h);
    let k=(4*w+8) as usize;
    assert!(g.slope[k] > 0.0 && g.slope[k] < 1.0);
    assert!((g.normal[k*3] ).abs() > 0.0, "normal tilts east");
    assert!(g.curvature[k].abs() < 1e-3, "linear ramp ⇒ ~zero curvature");
    assert!((0.0..=1.0).contains(&g.ao[k]));
}
```

- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement equirect-aware central-difference gradient (cos(lat) longitudinal metric — equirect storage), normal, curvature (Laplacian), AO (multi-tap horizon over `hf`, bounded taps — risk #5 cost noted). — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/geometry.rs apps/hayba-explorer/src-tauri/src/masks/mod.rs` → `feat(masks): geometry masks (slope/normal/curvature/AO, cos-lat aware)`.

### Task B3: Hydrology — drainage, river, deposition, wetness

**Files:** Create `masks/hydrology.rs`.

- [ ] **Step 1: Failing test** — on a single-valley equirect: drainage accumulates downstream, `river` set where drainage>τ, `wetness` high in valley. (Reuse `crate::hydrology` Braun–Willett accumulation — O(N), **not** naïve parallel-flood, satisfying risk #8.)
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement using `crate::hydrology::{priority_flood, flow_receivers, drainage_area}` adapted to the equirect raster (4/8-neighbour, seam-wrap U); `deposition` from the carried sediment if available else 0; `wetness=f(drainage,low-slope,distWater)`. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/hydrology.rs` → `feat(masks): drainage/river/deposition/wetness (reuses hydrology.rs, O(N))`.

### Task B4: Flow-Accumulation SDF + localRelief + shoreline SDF (risk #8 hardening)

**Files:** Modify `masks/hydrology.rs`.

- [ ] **Step 1: Failing test**

```rust
#[test]
fn flow_accum_sdf_widens_smoothly_and_localrelief_is_height_above_channel() {
    let (w,h)=(32,16); /* V-valley with a channel column */
    let m = hydrology::flow_sdf_and_local_relief(/*…*/);
    assert!(m.flow_sdf.iter().all(|v| v.is_finite()));
    // monotone away from the channel (no 1-px hard line)
    assert!(m.flow_sdf[channel] < m.flow_sdf[near] && m.flow_sdf[near] < m.flow_sdf[far]);
    assert!((m.local_relief[ridge] - (hf[ridge]-hf[channel])).abs() < 1e-3);
}
```

Add to the test (review B4 — an SDF must be a *distance field*, not a blur):

```rust
    // doubling resolution must NOT change the physical distance the SDF
    // encodes (a bilateral blur would scale with texel count — invalid).
    let lo = hydrology::flow_sdf_and_local_relief(/* w,h */);
    let hi = hydrology::flow_sdf_and_local_relief(/* 2w,2h, same geometry */);
    assert!((sample_at(&lo, p) - sample_at(&hi, p)).abs() < 1e-2,
            "SDF is resolution-independent Euclidean distance (JFA), not a blur");
```

- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement per the §6 HARDENING: drainage *accumulation* reuses `crate::hydrology` O(N) Braun–Willett (NOT naïve parallel-flood); the **SDF itself is the Jump-Flood Algorithm seeded by the river/channel mask** — the *same* JFA used for `distToOcean` (B6), O(log N), TDR-safe, true Euclidean distance. **A bilateral blur is explicitly rejected** (it produces a resolution-dependent value gradient, not a distance field — review B4). `localRelief = h_final − heightOfNearestChannel` (nearest-channel from the JFA's closest-seed pass — free byproduct); `shorelineSDF` = the same JFA seeded by the coastline, narrow band, seam-wrapped. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/hydrology.rs` → `feat(masks): flow-accum SDF via JFA (resolution-independent) + localRelief + shoreline SDF`.

## Phase B1 — CPU oracle: climate (ported) + isolated pre-erosion C_proxy

> **Review B3 (FATAL circular dep, fixed here):** `C_proxy` MUST be computed
> from the **pre-erosion macro `h0`** and run **before** Subsystem A (A consumes
> it). It is a separate, isolated function (Task B6b) — NOT derived from
> `h_final`. The `h_final` climate masks (B5/B6a) are a distinct later pass and
> never feed erosion. `C_proxy` is not a baked mask channel (B1 asserts this).

### Task B5: Equirect climate port (insolation, baseTemp+continentality, temperature)

**Files:** Create `masks/climate_eq.rs`.

- [ ] **Step 1: Failing test** — for a known (lat, elevation, distToOcean) the equirect path yields the **same** values (within 1e-4) as calling the existing `crate::climate` formula directly (oracle = the proven module). Continentality from final elevation (closes task #193).
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement by **calling `crate::climate` math** per equirect texel (lat from V, elevation from `h_final`, distToOcean from B4); do not re-derive — wrap the proven functions. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/climate_eq.rs` → `feat(masks): equirect climate port (reuses climate.rs; continentality)`.

### Task B6a: distToOcean (seam-wrapped JFA), precip (orographic+downwind), oceanCurrentDT — from `h_final`

**Files:** Modify `masks/climate_eq.rs`.

- [ ] **Step 1: Failing test** — distToOcean JFA is **seam-continuous** (u=0 vs u=1 equal); precip shows rain-shadow (windward > lee on a ridge). (No `C_proxy` here — see B6b.)
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement JFA `distToOcean` (log passes, U-wrap — the shared JFA from B4), precipitation (zonal + orographic on `h_final` slope vs prevailing wind + downwind moisture advection — port `climate.rs` moisture), `oceanCurrentDT` (fBm domain-warped gyre via `erosion::noise::domain_warp`). All from the **post-erosion `h_final`**. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/climate_eq.rs` → `feat(masks): h_final distToOcean (JFA) + orographic precip + ocean ΔT`.

### Task B6b: Isolated pre-erosion `compute_cproxy(h0)` (fixes the circular dependency)

**Files:** Modify `masks/climate_eq.rs` (add a standalone `compute_cproxy`).

- [ ] **Step 1: Failing test**

```rust
#[test]
fn cproxy_depends_only_on_h0_not_on_erosion_output() {
    // Same h0, two different (fake) h_final → identical C_proxy.
    let h0 = ramp_with_ridge(64, 32);
    let a = climate_eq::compute_cproxy(&h0, 64, 32, /*cproxy_res*/16);
    let a2 = climate_eq::compute_cproxy(&h0, 64, 32, 16);
    assert_eq!(a, a2, "deterministic, h0-only");
    assert!(a.iter().all(|v| v.is_finite()));
    // windward side of the ridge gets a higher orographic proxy than lee
    assert!(sample(&a, windward) > sample(&a, lee));
}
```

- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement `pub fn compute_cproxy(h0:&[f32], w:u32, h:u32, res:u32) -> Vec<f32>` — a low-res prevailing-wind orographic raymarch over **`h0` only** (spec §5.3). It takes NO `h_final`/erosion input. It is the function Subsystem A Task A6/A7 (via `wizard.rs`) calls **before** the pyramid. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/climate_eq.rs` → `feat(masks): isolated pre-erosion compute_cproxy(h0) — breaks the circular dep`.

### Task B7: Wire real C_proxy back into Subsystem A's detail injection

**Files:** Modify `src-tauri/src/wizard.rs` (`bake_erode_v2_impl` / `bake_h0_v2_impl`), `src-tauri/src/erosion/pyramid.rs` (A6 `inject_detail_band` modulation input).

- [ ] **Step 1: Failing test** — `bake_erode_v2_impl` with a draft that has a windward/lee ridge produces **more added detail on the windward side** than the lee (C_proxy steering active, not the placeholder uniform slope).
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** In `wizard.rs`, **before** the pyramid runs: build `h0` (A's rasterize), call `climate_eq::compute_cproxy(&h0_equirect,…)` (B6b — pre-erosion, h0-only), resample `C_proxy` to the cube-sphere, and pass it as the `inject_detail_band` modulation array (A6's per-texel hook). Strictly ordered: `h0 → compute_cproxy(h0) → pyramid`. No `h_final` exists yet at this point (proves non-circular). — [ ] **Step 4:** PASS; full `cargo test --lib` green. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/wizard.rs apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs` → `feat(masks): C_proxy(h0) steers erosion detail pre-pyramid (rain-shadow, non-circular)`.

## Phase B2 — CPU oracle: classification, transitions, pattern-break, brushes

### Task B8: biome (Whittaker) → `biomePrimary`, `biomeSecondary`, `blendWeight`

**Files:** Create `masks/transition.rs`.

> **Review C3 (ALU/sampler fix):** do NOT emit a 10-slot weight vector — that
> forces a 10-iteration loop + illegal dynamic sampler-array indexing in the
> live shader. Emit exactly **three** RGBA8 channels: `biomePrimary` (dominant
> biome id, normalized for the texture-array layer index), `biomeSecondary`
> (next biome id), `blendWeight` (>0 only inside `noisePerturbedFrontier`).
> Subsystem C then does exactly two `sampler2DArray` taps + one `mix`.

- [ ] **Step 1: Failing test** — known (temp,precip) → expected Whittaker primary id; at a biome boundary `biomeSecondary` = the neighbouring biome and `blendWeight∈(0,1)`; deep in an interior `blendWeight==0` and `biomePrimary==biomeSecondary`. Oracle = `crate::climate` Whittaker.
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Port `crate::climate` Whittaker into the equirect domain; compute the per-texel dominant + runner-up biome from the neighbour-diffused field; `blendWeight` = the diffused mixing fraction gated to the frontier band (0 in interiors). Output 3 scalar channels (RGBA8-friendly), not 10. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/transition.rs` → `feat(masks): Whittaker biome → primary/secondary/blendWeight (2-tap shading, no hex)`.

### Task B9: Sobel frontier + noise-perturbed frontier

**Files:** Modify `masks/transition.rs`.

- [ ] **Step 1: Failing test** — Sobel of biomeId is high only at boundaries; `noisePerturbedFrontier` = Sobel band displaced by `edgeBreak` (wiggly, finite, band-limited; identical interiors → 0).
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement Sobel magnitude on `biomeId`, widen to a band, displace sample coord by `erosion::noise::domain_warp` (the baked `edgeBreak`). — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/transition.rs` → `feat(masks): Sobel frontier + domain-warped (wiggly) frontier band`.

### Task B10: Pattern-break masks + per-biome brushes (ALU Bake Enforcement)

**Files:** Create `masks/patterns.rs`.

- [ ] **Step 1: Failing test** — `macroVariation`/`mesoDetail`/`edgeBreak` deterministic, seam-continuous, in range; `rockExposure≈slope*curvature`; `dune`/`vegetationPatch` from worley, finite. Assert these are **plain arrays** (proving they are baked, not deferred to live).
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement using `erosion::noise` (fbm/worley/domain_warp) at sphere position; `microCohesion` = a small fixed `micro_bleed_px` **edge-aware bilateral bleed of the biome/SatMap-base, hard-stopped at `sobelFrontier`** (never crosses biomes). — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/patterns.rs` → `feat(masks): baked pattern-break + per-biome brushes + edge-aware micro-bleed`.

### Task B11: `compute_masks_cpu` orchestrator + `bake_masks_v2` command

**Files:** Modify `masks/mod.rs`, `wizard.rs`, `lib.rs`.

- [ ] **Step 1: Failing tests** — `compute_masks_cpu(h_final,w,h,cfg)` returns every catalog channel, all finite, correctly laid out per `MASK_LAYOUT`; `#[tauri::command] bake_masks_v2` returns the packed MRT buffers; `cargo test --lib` fully green.
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement the orchestrator (geometry→hydrology→flowSDF/localRelief→climate(h_final)→biome→frontier→patterns→pack per layout — **note `C_proxy` is NOT here; it ran pre-erosion in B6b/B7**); `bake_masks_v2(h_final, mask_config)` → `MaskBakeResult { textures: Vec<(Fmt,Vec<f32>)>, w, h }` (per-target format carried, review B1); register in `lib.rs`. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/mod.rs apps/hayba-explorer/src-tauri/src/wizard.rs apps/hayba-explorer/src-tauri/src/lib.rs` → `feat(masks): compute_masks_cpu orchestrator + bake_masks_v2 (CPU oracle complete)`.

## Phase B3 — GPU port + `sampleField()` interface

### Task B12: GLSL mask passes (ports of B2–B10)

**Files:** Create `src/viewport/bake/masks.glsl.ts` + `masks.glsl.test.ts` (shape test: each export has `void main`, no backticks — same guard as Plan A Task A14).
- [ ] Steps 1–5 mirror Plan A Task A14: failing shape-test → implement faithful GLSL ports (MRT outputs per `MASK_LAYOUT`; jump-flood, Sobel, bilateral micro-bleed, noise all in GLSL, seam-wrapped) → PASS → commit `feat(masks): GLSL mask passes (ports of CPU oracle)`.

### Task B13: GPU MRT orchestrator `masksPipeline.ts` (multi-pass, ≤4 targets/pass)

**Files:** Create `src/viewport/bake/masksPipeline.ts` + `masksPipeline.test.ts`.

> **Review B2 (NORMATIVE):** WebGL2 only guarantees `MAX_COLOR_ATTACHMENTS = 4`
> (many integrated/Apple GPUs cap there). An ≤8-target single MRT draw fails to
> compile on that hardware.

- [ ] **Step 1: Failing test** (`masksPipeline.test.ts`, pure schedule logic):

```ts
// Run: npx tsx src/viewport/bake/masksPipeline.test.ts
import assert from "node:assert/strict";
import { maskPassPlan } from "./masksPipeline";
const plan = maskPassPlan({ maxColorAttachments: 4 });
assert.ok(plan.length >= 2, "split into >=2 passes");
for (const p of plan) assert.ok(p.targets.length <= 4, "<=4 MRT targets/pass");
// every catalog channel is produced exactly once across the passes
assert.equal(new Set(plan.flatMap(p=>p.targets.flatMap(t=>t.channels))).size,
             plan.flatMap(p=>p.targets.flatMap(t=>t.channels)).length);
console.log("ok");
```

- [ ] **Step 2:** `npx tsx src/viewport/bake/masksPipeline.test.ts` → FAIL.
- [ ] **Step 3:** Implement `maskPassPlan(caps)` — queries `gl.getParameter(gl.MAX_COLOR_ATTACHMENTS)`, partitions the `MASK_LAYOUT` targets into passes of ≤`min(caps,4)` MRT attachments (e.g. Pass 1 = geometry+hydrology, Pass 2 = climate+transition+patterns); each target carries its per-`Fmt` (review B1). `runMaskBake(renderer, hFinalTex, cfg) -> MaskTextureSet` executes the plan via the Plan-A ping-pong/MRT helpers + `masks.glsl`, allocating each RT at its assigned format. — [ ] **Step 4:** PASS; `npx tsc -b` clean. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/viewport/bake/masksPipeline.ts apps/hayba-explorer/src/viewport/bake/masksPipeline.test.ts` → `feat(masks): multi-pass MRT orchestrator (≤4 targets/pass, per-target format)`.

### Task B14: CPU↔GPU mask parity (extend Plan A harness)

**Files:** Modify `src/viewport/bake/parity.ts`; Modify `App.tsx`.
- [ ] Extend parity to compare every GPU mask channel vs `bake_masks_v2` at low res; PASS gate `RMSE<3e-3` per channel (looser for jump-flood/sobel; document per-channel tolerances). Fix GLSL drift until PASS. Commit `test(masks): CPU↔GPU mask parity — passing`.

### Task B15: `sampleField()` interface (the §9 contract; VT-stubbed)

**Files:** Create `src/viewport/bake/sampleField.ts` + `sampleField.test.ts`.
- [ ] **Step 1: Failing test** — `SampleField` exposes typed getters for every catalog channel; Phase-1 backing returns the global equirect texel; `vtEnabled===false` stub path returns the global level (logic-testable without GL via an injected fake sampler).
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement `SampleField` wrapping the `MaskTextureSet` + `hFinal`; documented uniform/texture-binding map for Subsystem C; explicit `// Phase 2: CDLOD quadtree replaces the backing here (spec §9)`. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/viewport/bake/sampleField.ts apps/hayba-explorer/src/viewport/bake/sampleField.test.ts` → `feat(masks): sampleField() contract (Phase-1 global; VT-stub behind interface)`.

### Task B16: Chain A→B in bake action + per-mask debug map-modes

**Files:** Modify `App.tsx`, `src/viewport/bake/debugMaterial.ts`.
- [ ] Wire bake: `bake_h0_v2`→A `runErodeBake`→`runMaskBake`→`SampleField`; extend the debug material with a map-mode selector cycling every catalog channel (reuse the EU5 overlay). tsx test for the map-mode enum exhaustiveness. Commit `feat(masks): A→B bake chain + per-mask debug map-modes`.

## Phase B4 — Validation

### Task B17: Visual validation (Earth + painted)
- [ ] Bake Earth template; verify per spec §12: temperature matches real annual-mean (continentality — Sahara hot, Siberia/Tibet cold), precip rain-shadow correct (India/Indochina not desertified), biome map plausible, frontiers wiggly (not straight), rivers widen smoothly (flowSDF, no 1-px lines), no seam scar at ±180°, mask cost measured (risk #5 — log pass count/timings). Validate **visually** per standing rule. File fix tasks for any failure before B sign-off. Commit (notes) `docs(masks): Subsystem B visual-validation results + sign-off`.

---

## Self-Review

**Spec §6 coverage:** every catalog group → B2 (geometry+AO), B3/B4 (hydrology incl. flowSDF/localRelief/shoreline), B5/B6a (h_final climate ported, continentality closes #193, JFA distToOcean, orographic precip, ocean ΔT), B6b/B7 (isolated pre-erosion C_proxy(h0)), B8/B9 (biome primary/secondary/blendWeight + Sobel/noise-perturbed frontier), B10 (pattern-break + per-biome brushes + edge-aware micro-bleed), B11 (orchestrator+command), ALU Bake Enforcement satisfied, §9 `sampleField` → B15.

**Architecture-review fixes folded in:** **(B1, VRAM bomb)** per-target formats `Fmt{RGBA8|16F|32F}` in `MASK_LAYOUT`; B1 test asserts total mask VRAM < ~1.6 GB and unorm masks are RGBA8 — no blanket 32F. **(B2, MRT limit)** B13 `maskPassPlan` queries `MAX_COLOR_ATTACHMENTS` and splits into ≥2 passes of ≤4 targets. **(B3, FATAL circular dep)** `C_proxy` split into isolated `compute_cproxy(h0)` (B6b) run *before* the pyramid (B7), removed from the mask catalog/layout (B1 test asserts it's absent); h_final climate (B6a) is a separate later pass. **(B4, invalid SDF)** Flow-Accum + shoreline SDF use **JFA seeded by the river/coast mask** (resolution-independent, the B6a JFA), bilateral blur explicitly rejected and pinned by a resolution-invariance test. **(C3, biome model)** B8 emits `biomePrimary/biomeSecondary/blendWeight` (3 RGBA8 channels), not a 10-slot vector — enables 2-tap `sampler2DArray` shading in C.

**Placeholder scan:** GLSL bodies (B12) = faithful ports of named, tested CPU functions + shape test (Plan A A14 rigor); `MASK_LAYOUT` concrete (B1 pins disjointness + formats). **Type consistency:** `MaskConfig`, `Fmt`, `MASK_LAYOUT`, `compute_masks_cpu`, `compute_cproxy`, `bake_masks_v2`, `MaskBakeResult`, `maskPassPlan`, `runMaskBake`, `MaskTextureSet`, `SampleField`, `biomePrimary/biomeSecondary/blendWeight` consistent across tasks and with Plan A (`erosion::noise`, `h_final`, JFA shared with `distToOcean`). **Scope:** Subsystem B only; C consumes `SampleField`, D consumes C.
