# Climate S1 Fixes + Tuning UX — Implementation Plan

> Spec: `docs/research/2026-05-15-climate-texturing-qa-and-tuning-ux.md`. Execute via superpowers:subagent-driven-development. Commit on `chore/repo-restructure`, no Co-Authored-By, stage named files only, never disable gpg.

**Goal:** Fix the four S1 model flaws (A2 dual-biome truth, A1 missing moisture transport, A4 fictional currents, A3 texture crawl) and add the `ClimateParams` tuning plumbing + Climate Lab UX. The stochastic-anti-contour fix is already shipped (commit prior).

**Key files:** `apps/hayba-explorer/src-tauri/src/climate.rs`, `.../planet.rs`, `.../wizard.rs`; `apps/hayba-explorer/src/viewport/{mesh.ts,shaders/planet.glsl.ts}`, `App.tsx`, panels.

**Existing facts:** `compute_climate(model, seed, want_debug) -> ClimateFields { temperature, precip, biome, debug }`, called every step in `snapshot_model`. Shader packs 20 scalars into 5 vec4 (`aPack0..4`); adding fields = add `aPack5` (attr budget fine: 3 builtins + 6 vec4 = 9 ≤ 16). `classify_biome(temp,precip)->u8` hard cuts; consts `BIOME_*` 0..9. Shader currently re-derives soft biome weights (`warpT/warpP/wIce..wDes`) — to be deleted in T-A2.

---

## Task A2: Single biome source of truth

**Files:** `climate.rs`, `planet.rs`, `App.tsx` (interface), `mesh.ts`, `planet.glsl.ts`.

Rust becomes the only biome authority and ships, per cell: `biome` (primary id), `biome2` (secondary id), `biome_blend` (0 = pure primary … →0.5 at an organic boundary). The shader renders `mix(sampleBiome(primary), sampleBiome(secondary), blend)` and **deletes** its `warpT/warpP/wIce..wDes` block. Biome map mode then shows exactly the rendered classification.

- [ ] **Step 1 — climate.rs: emit primary/secondary/blend.** In `compute_climate`, after `let pr` / `let t`, replace `biome[i] = classify_biome(t,pr) as f32;` with:

```rust
let primary = classify_biome(t, pr);
// Organic boundary: deterministic per-cell nudge of (temp,precip) toward
// a neighbouring Whittaker cell. value_noise is stable per world pos +
// seed (cell-stable seed lands in T-A3; for now seed+pos is acceptable).
let nT = (value_noise(p * 9.0, seed ^ 0x9E37) - 0.5) * 6.0;      // ±3 °C
let nP = (value_noise(p * 9.0, seed ^ 0x1234) - 0.5) * 0.20;     // ±0.1
let secondary = classify_biome(t + nT, (pr + nP).clamp(0.0, 1.0));
// Blend rises only where the nudged sample actually crosses into a
// different biome AND we're near that crossing (soft edge).
let blend = if secondary == primary { 0.0 }
            else { 0.5 * smoothstep01((nT.abs()/3.0 + nP.abs()/0.10) * 0.5) };
biome[i]   = primary as f32;
biome2[i]  = secondary as f32;
bblend[i]  = blend;
```

Add a private `fn smoothstep01(x:f32)->f32 { let t=x.clamp(0.0,1.0); t*t*(3.0-2.0*t) }` (or reuse existing `smoothstep`). Add `biome2: Vec<f32>` and `biome_blend: Vec<f32>` to `ClimateFields` (init `vec![0.0;n]`, push in the loop). Add a unit test: a cell whose primary≠secondary has `0.0 < blend ≤ 0.5`; a deep-interior cell with primary==secondary has `blend==0`.

- [ ] **Step 2 — planet.rs:** add `cell_biome2: Vec<f32>`, `cell_biome_blend: Vec<f32>` to `PlanetSnapshot`; in `snapshot_model` pull from `cf.biome2` / `cf.biome_blend`. Update the `snapshot_has_climate_fields` test to assert lengths.

- [ ] **Step 3 — App.tsx interface:** add `cell_biome2: number[]; cell_biome_blend: number[];` to `PlanetSnapshot`.

- [ ] **Step 4 — mesh.ts:** add `aPack5` (vec4) buffer + geom attribute. Pack `(biome, biome2, biomeBlend, _)`. NOTE biome already lives in `aPack2.w`; move/duplicate is fine — put the canonical trio in `aPack5` and leave `aPack2.w` as-is (still read as `vBiome` for the map mode if you prefer, but make the render use `aPack5`). Fill in `updateFromSnapshot`: `pack5[j]=cell_biome[i]; pack5[j+1]=cell_biome2[i]; pack5[j+2]=cell_biome_blend[i];`. Add `aPack5` to the `needsUpdate` loop.

- [ ] **Step 5 — planet.glsl.ts vertex:** add `attribute vec4 aPack5;`, `varying float vBiome2; varying float vBiomeBlend;`; assign `vBiome = aPack5.x; vBiome2 = aPack5.y; vBiomeBlend = aPack5.z;` (replace the old `vBiome = aPack2.w;`). Fragment: add the two varyings.

- [ ] **Step 6 — planet.glsl.ts fragment:** DELETE the entire `warpT/warpP/wIce/wTun/wBor/warm/hotw/temperateW/wTRf..wDes` block and the 10-way weighted `base = …/wSum`. Replace with:

```glsl
    vec3 base = mix(
      sampleBiome(vBiome,  remapBiomeH(vBiome,  hLand, hIce)),
      sampleBiome(vBiome2, remapBiomeH(vBiome2, hLand, hIce)),
      clamp(vBiomeBlend * 2.0, 0.0, 1.0));
```

where `sampleBiome(id,h)` is the existing dispatch and add a tiny helper `float remapBiomeH(float id,float hl,float hi){ float h = (id>8.5)?hi:hl; return remapH(h, uBiomeRemap[int(id+0.5)]); }`. Keep `rock` line. Keep ice/snow/beach/lighting downstream. The biome map mode keeps using `biomeDebugColor(vBiome)` — now faithful.

- [ ] **Step 7:** `cargo test --lib` green, `npx tsc --noEmit` clean, `cargo build --lib` clean. Commit `feat(climate): single biome source of truth (Rust primary/secondary/blend; shader deletes divergent thresholds)`.

---

## Task A1: Downwind moisture transport (the real rain shadow)

**Files:** `climate.rs`.

The spec'd-but-never-built sweep. After distance-to-ocean BFS and per-cell wind, run a **bounded ordered moisture sweep** before final precip.

- [ ] **Step 1 — climate.rs:** add `fn upwind_neighbour(grid_pos: &[Vec3], neighbours:&[Vec<u32>], i:usize, wind:Vec3) -> Option<u32>`: returns the neighbour `nb` maximising `dot((p_i - p_nb).normalize(), wind)` (i.e. the one the wind comes FROM). Add unit test on the synthetic chain (wind +x → upwind is the −x neighbour).

- [ ] **Step 2 — moisture sweep in `compute_climate`** (after wind/orographic, before final `pr`):

```rust
// Source: ocean cells = full moisture; onshore-wind coasts inject it.
let mut moist = vec![0.0f32; n];
for i in 0..n { if is_ocean[i] { moist[i] = 1.0; } }
let winds: Vec<Vec3> = (0..n).map(|i| prevailing_wind(pos[i])).collect();
let up: Vec<i64> = (0..n).map(|i|
    upwind_neighbour(&pos,&neighbours,i,winds[i]).map(|x|x as i64).unwrap_or(-1)).collect();
// Bounded relaxation: moisture carried from upwind, decayed by distance,
// blocked by relief rising into the wind. K constant → O(cells·K).
for _ in 0..6 {
    for i in 0..n {
        if is_ocean[i] { continue; }
        let u = up[i];
        if u < 0 { continue; }
        let ui = u as usize;
        let rise = (elev[i] - elev[ui]).max(0.0);          // climbing into wind
        let block = 1.0 - smoothstep(0.06, 0.20, rise);    // relief barrier
        let decay = 0.94;                                  // per-hop loss
        moist[i] = moist[i].max(moist[ui] * decay * block);
    }
}
```

- [ ] **Step 3 — fold into precip.** Replace the precip combine with a physically ordered form:

```rust
let base_h = zonal_precip(lat).max(moist[i] * 0.85);       // transported + zonal
let oro    = orographic.max(0.0) * 0.6;                     // windward enhance
let lee    = (-orographic).max(0.0) * 0.5;                  // rain shadow cut
let dry    = 1.0 - cont;                                    // continental depletion
let pr = (base_h + oro - lee - dry * 0.5
          + (value_noise(p*3.5,seed)-0.5)*0.12).clamp(0.0,1.0);
```

- [ ] **Step 4:** add a test: build a synthetic windward-mountain-then-lee chain (ocean, rising cells, then descending) and assert lee cells are drier than windward by a clear margin. `cargo test --lib` green. Commit `feat(climate): bounded downwind moisture transport — real rain shadows`.

---

## Task A4: Geographic ocean currents (not fixed longitude)

**Files:** `climate.rs`.

Replace `fract(lon/(2π/3))` basin guess with currents derived from real ocean geometry.

- [ ] **Step 1:** rewrite `current_temp_anomaly` (or replace its call site) so the anomaly is driven by the **distance-to-ocean gradient** and latitude: a coastal cell is warmed if its adjacent ocean lies *equatorward* of it (warm water advected poleward up that coast) and cooled if the adjacent ocean lies *poleward* (cold upwelling/equatorward current). Per land/coast cell `i`: find the mean direction to nearby ocean `oceanDir` = normalize(Σ (p_nb − p_i) over ocean neighbours within 2 rings). `anomaly = coastalFactor * sign(dot(oceanDir, equatorwardDir(p_i))) * strength`, where `equatorwardDir = -sign(p.y) * latitudeTangent`. Magnitude tapered by `|lat|` (peak ~45–60°) and `coastalness` (→0 inland). This ties warming/cooling to where the ocean actually is, and shifts coherently as continents drift.

- [ ] **Step 2:** update the existing `current_anomaly_bounded_and_signed` test (bounds unchanged: |Δ|≤12, ~0 deep inland). Add: a coast with ocean on its equator side is warmed (positive), ocean on its pole side is cooled (negative). `cargo test --lib` green. Commit `feat(climate): geography-derived ocean currents (ocean-direction × latitude)`.

---

## Task A3: Cell-stable texture coordinate (kill the world-space crawl)

**Files:** `climate.rs`, `planet.rs`, `App.tsx`, `mesh.ts`, `planet.glsl.ts`.

The within-biome stochastic texture keys on `vWorldNormal`; as plates drift the crust slides through a space-locked field → crawl. Ship a per-cell **stable** unit vector (function of the immutable cell index) and key the macro/scatter noise on THAT.

- [ ] **Step 1 — climate.rs:** `compute_climate` already loops cells; emit `cell_seed: Vec<f32>` of length n*3 — for cell index `i`, a deterministic pseudo-random unit vec3 from `hash3i(i,seed)` style (reuse `hash3`/`value_noise` building blocks); pack 3 floats per cell. Add to `ClimateFields`.

- [ ] **Step 2 — planet.rs / App.tsx:** add `cell_seed: Vec<f32>` (n*3) to `PlanetSnapshot` + TS interface.

- [ ] **Step 3 — mesh.ts:** put the seed vec3 into `aPack5.w` is only 1 float — instead add `aSeed` as its own `vec3` attribute (attr budget: 3 builtins + 6 vec4 + 1 vec3 = 10 ≤ 16, fine) OR pack seed.xyz into the spare lanes of aPack5 (aPack5 = biome,biome2,blend,_ — only .w spare). Cleanest: dedicated `geom.setAttribute("aSeed", BufferAttribute(seed, 3))`. Fill in `updateFromSnapshot`.

- [ ] **Step 4 — planet.glsl.ts:** add `attribute vec3 aSeed; varying vec3 vSeed;` (vertex) + `varying vec3 vSeed;` (fragment). In the colour block, replace the noise domains that drive **within-biome texture only** — `macro = fbm(vWorldNormal*3 + cwarp)`, `scatter = hash3(vWorldNormal*850) + fbm(vWorldNormal*220)`, and `cwarp` — with `vSeed`-based coordinates (e.g. `vSeed * 3.0`, `vSeed * 850.0`). Do NOT change climate/biome (those legitimately follow world position / are Rust-side). Result: the texture is painted on the crust and rides with it; biomes still re-evaluate per step as climate changes.

- [ ] **Step 5:** `cargo test --lib`, `tsc`, `cargo build` green. Commit `fix(climate): cell-stable texture coordinate — surface no longer crawls under drifting plates`.

---

## Task 5: ClimateParams plumbing + Climate Lab panel

**Files:** `climate.rs`, `planet.rs`, `wizard.rs`, `App.tsx`, new `ClimateLabPanel.tsx`, `CategoryStrip.tsx`, `RightPanel.tsx`.

- [ ] **Step 1 — climate.rs:** `#[derive(Clone, Debug, Deserialize)] pub struct ClimateParams { ... }` with `#[serde(default)]` field defaults equal to the current consts: `t_equator(30)`, `t_lat_drop(50)`, `lat_curve(1.0=sin²..0=linear)`, `lapse_c_per_km(4.46)`, `elev_km_scale(8)`, `continental_cool(6)`, `current_strength(12/-10)`, `itcz_width(16)`, `subtrop_dry(12)`, `midlat_wet(14)`, `moisture_decay(0.94)`, biome threshold temps/precips. `Default` impl = current values. `compute_climate(model, seed, want_debug, params: &ClimateParams)` — thread params into every formula (replace the hardcoded consts).

- [ ] **Step 2 — wizard.rs/planet.rs:** `snapshot_model(..., params: &ClimateParams)`; `step_planet`/`bake_from_wizard` Tauri commands gain `climate_params: ClimateParams` (`#[serde(default)]`). Default callers pass `ClimateParams::default()`.

- [ ] **Step 3 — App.tsx:** `climateParams` state (TS interface mirroring the struct, all optional/defaulted); pass `climateParams` in the `step_planet`/`bake_from_wizard` invokes; changing it re-invokes a snapshot (reuse the existing step path / a "recompute" call).

- [ ] **Step 4 — ClimateLabPanel.tsx + new `"climate"` PanelCategory** (mirror the Texturing category wiring: `PanelCategory` union, `CategoryStrip` ITEMS, `RightPanel` TITLES, App `categoryEnabled` post-bake). Grouped collapsible slider sections per QA §B3 (Temperature / Moisture / Orographic / Continentality / Currents / Biome thresholds). Each slider: label, live value, reset. **Auto-pair:** focusing a group calls `setMapMode(thatGroupsMode)` so the on-canvas Map switches to the diagnostic mask. **Presets** dropdown (Earth/Arid/Ice/Ocean/Hothouse) sets the whole param object.

- [ ] **Step 5 (stretch):** 2-D Whittaker editor component — a temp×precip canvas with draggable biome region cells; emits the biome-threshold params. If time-boxed out, ship sliders only and leave a TODO note in the panel.

- [ ] **Step 6:** `cargo test --lib`, `tsc`, `cargo build`, `npm run build` green. Commit `feat(climate): ClimateParams plumbing + Climate Lab tuning panel`.

---

## Verification (definition of done)

- `cargo test --lib` green incl. new A2/A1/A4/A3 tests.
- `tsc --noEmit` + `cargo build --lib` + `npm run build` clean.
- Biome map mode == rendered biomes (A2).
- Orographic/Precipitation modes show real lee deserts extending inland (A1).
- Current ΔT mode follows actual coasts and is stable across steps (A4).
- Stepping the sim: surface texture rides with continents, no crawl (A3).
- Climate Lab sliders + presets retune the planet live; focusing a group switches the on-canvas Map mode (UX).

After all tasks: `superpowers:finishing-a-development-branch`.
