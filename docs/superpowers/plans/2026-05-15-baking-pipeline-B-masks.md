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
3. **Climate (ported from `climate.rs`):** `insolation`, `baseTemp`(continentality from final elev), `temperature`, `distToOcean`(seam-wrapped jump-flood), `precip`(orographic+downwind), `oceanCurrentDT`(domain-warped), `Cproxy`(low-res orographic — also fed back to A6).
4. **Classification/transition:** `biomeId`, `biomeWeights[10]`, `sobelFrontier`, `noisePerturbedFrontier`.
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
  #[test] fn layout_packs_all_channels_without_overlap() {
    let l = layout::MASK_LAYOUT;
    assert!(l.texture_count() <= 8, "fits MRT budget");
    assert!(l.is_disjoint(), "no two masks share a (texture,channel)");
    assert!(l.contains("localRelief") && l.contains("Cproxy") && l.contains("microCohesion"));
  }
}
```

- [ ] **Step 2:** `cargo test --lib masks::tests::layout` → FAIL.
- [ ] **Step 3:** Implement `MaskConfig` (`#[serde(default)]`: `equirect_w:8192, equirect_h:4096, micro_bleed_px:5, cproxy_res:256, jump_flood:true, seed`), `layout.rs::MASK_LAYOUT` = a static table mapping each catalog name → `(texture_index, channel)` with `texture_count`/`is_disjoint`/`contains`.
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

- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement per the §6 HARDENING: **no naïve parallel-flood over 33M texels** — compute the SDF via an **edge-preserving bilateral blur of the final water/drainage keyed to the height gradient** (bounded passes); `localRelief = h_final − heightOfNearestChannel` from the same channel set; `shorelineSDF` = jump-flood signed distance to coast, narrow band, seam-wrapped. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/hydrology.rs` → `feat(masks): flow-accum SDF (bilateral, TDR-safe) + localRelief + shoreline SDF`.

## Phase B1 — CPU oracle: climate (ported) + C_proxy

### Task B5: Equirect climate port (insolation, baseTemp+continentality, temperature)

**Files:** Create `masks/climate_eq.rs`.

- [ ] **Step 1: Failing test** — for a known (lat, elevation, distToOcean) the equirect path yields the **same** values (within 1e-4) as calling the existing `crate::climate` formula directly (oracle = the proven module). Continentality from final elevation (closes task #193).
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement by **calling `crate::climate` math** per equirect texel (lat from V, elevation from `h_final`, distToOcean from B4); do not re-derive — wrap the proven functions. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/climate_eq.rs` → `feat(masks): equirect climate port (reuses climate.rs; continentality)`.

### Task B6: distToOcean (seam-wrapped jump-flood), precip (orographic+downwind), oceanCurrentDT, C_proxy

**Files:** Modify `masks/climate_eq.rs`.

- [ ] **Step 1: Failing test** — distToOcean jump-flood is **seam-continuous** (u=0 vs u=1 equal); precip shows rain-shadow (windward > lee on a ridge); `Cproxy` is a low-res orographic field finite & non-trivial.
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement jump-flood distToOcean (log passes, U-wrap), precipitation (zonal + orographic on `h_final` slope vs prevailing wind + downwind moisture advection — port `climate.rs` moisture), `oceanCurrentDT` (fBm domain-warped gyre via `erosion::noise::domain_warp`), `Cproxy` at `cproxy_res` (the orographic proxy that **Subsystem A Task A6 consumes** — expose `compute_cproxy(draft)->Vec<f32>` callable standalone so A can pre-fetch it). — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/climate_eq.rs` → `feat(masks): jump-flood distToOcean + orographic precip + ocean ΔT + C_proxy`.

### Task B7: Wire real C_proxy back into Subsystem A's detail injection

**Files:** Modify `src-tauri/src/wizard.rs` (`bake_erode_v2_impl` / `bake_h0_v2_impl`), `src-tauri/src/erosion/pyramid.rs` (A6 `inject_detail_band` modulation input).

- [ ] **Step 1: Failing test** — `bake_erode_v2_impl` with a draft that has a windward/lee ridge produces **more added detail on the windward side** than the lee (C_proxy steering active, not the placeholder uniform slope).
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Compute `Cproxy` (B6) before the pyramid; pass it as the `inject_detail_band` modulation array (A6 already accepts a per-texel modulation hook). Resample `Cproxy` cube-sphere-side. — [ ] **Step 4:** PASS; full `cargo test --lib` green. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/wizard.rs apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs` → `feat(masks): close A↔B loop — real C_proxy steers erosion detail (rain-shadow)`.

## Phase B2 — CPU oracle: classification, transitions, pattern-break, brushes

### Task B8: biome (Whittaker) + continuous biomeWeights

**Files:** Create `masks/transition.rs`.

- [ ] **Step 1: Failing test** — known (temp,precip) → expected Whittaker biome id; weights sum≈1, dominant matches id, per-texel (no hex). Oracle = `crate::climate` Whittaker.
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Port `crate::climate` Whittaker + neighbour-diffused 10-slot weights into the equirect domain. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/transition.rs` → `feat(masks): Whittaker biome + continuous per-texel weights (no hex)`.

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
- [ ] **Step 2:** FAIL. — [ ] **Step 3:** Implement the orchestrator (geometry→hydrology→flowSDF/localRelief→climate→C_proxy→biome→frontier→patterns→pack per layout); `bake_masks_v2(h_final, mask_config)` → `MaskBakeResult { textures: Vec<Vec<f32>>, w, h }`; register in `lib.rs`. — [ ] **Step 4:** PASS. — [ ] **Step 5: Commit** `git add apps/hayba-explorer/src-tauri/src/masks/mod.rs apps/hayba-explorer/src-tauri/src/wizard.rs apps/hayba-explorer/src-tauri/src/lib.rs` → `feat(masks): compute_masks_cpu orchestrator + bake_masks_v2 (CPU oracle complete)`.

## Phase B3 — GPU port + `sampleField()` interface

### Task B12: GLSL mask passes (ports of B2–B10)

**Files:** Create `src/viewport/bake/masks.glsl.ts` + `masks.glsl.test.ts` (shape test: each export has `void main`, no backticks — same guard as Plan A Task A14).
- [ ] Steps 1–5 mirror Plan A Task A14: failing shape-test → implement faithful GLSL ports (MRT outputs per `MASK_LAYOUT`; jump-flood, Sobel, bilateral micro-bleed, noise all in GLSL, seam-wrapped) → PASS → commit `feat(masks): GLSL mask passes (ports of CPU oracle)`.

### Task B13: GPU MRT orchestrator `masksPipeline.ts`

**Files:** Create `src/viewport/bake/masksPipeline.ts` (+ tsx test for the pass-schedule logic only). Implements `runMaskBake(renderer, hFinalTex, cfg) -> MaskTextureSet` via ping-pong/MRT + `masks.glsl`. Steps mirror Plan A Task A15. Commit `feat(masks): GPU MRT mask-library orchestrator`.

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

**Spec §6 coverage:** every catalog group → B2 (geometry+AO), B3/B4 (hydrology incl. flowSDF/localRelief/shoreline — risk #8 bilateral, TDR-safe), B5/B6 (climate ported, continentality closes #193, jump-flood distToOcean, orographic precip, ocean ΔT, C_proxy), B7 (closes the A↔B C_proxy loop the Plan-A self-review flagged), B8/B9 (biome/weights/Sobel/noise-perturbed frontier), B10 (pattern-break + per-biome brushes + edge-aware micro-bleed), B11 (orchestrator+command), ALU Bake Enforcement satisfied (all multi-octave noise + micro-bleed produced in B10/B11 bake, asserted as plain arrays; live = O(1) in Subsystem C), §9 `sampleField` → B15. **Placeholder scan:** GLSL bodies (B12) specified as faithful ports of named, tested CPU functions + shape test (same rigor as Plan A A14); `MASK_LAYOUT` table is concrete (B1 test pins disjointness). **Type consistency:** `MaskConfig`, `MASK_LAYOUT`, `compute_masks_cpu`, `bake_masks_v2`, `MaskBakeResult`, `runMaskBake`, `MaskTextureSet`, `SampleField`, `compute_cproxy` used identically across tasks and consistent with Plan A names (`erosion::noise`, `h_final`). **Scope:** Subsystem B only; C consumes `SampleField`, D consumes C.
