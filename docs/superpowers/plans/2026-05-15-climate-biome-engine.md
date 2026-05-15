# Climate + Biome Texturing Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-shader pseudo-climate with a Rust per-step O(cells) annual-mean scientific climate model (worldbuildingpasta-grounded) that classifies each cell into one of 10 Whittaker biomes; the shader then colours each biome's SatMap as a domain-warped organic-noise ramp so colour = f(biome, noise) only — making contour rings, semantic scramble, mud, orange artifacts, and the grey pole mathematically impossible.

**Architecture:** New pure module `apps/hayba-explorer/src-tauri/src/climate.rs` with `compute_climate(grid, fields, seed, want_debug) -> ClimateFields`, called inside `snapshot_model()` (which both `bake_from_wizard` and `step_planet` already call → runs every step). Three new always-shipped per-cell f32 arrays (`cell_temperature`, `cell_precip`, `cell_biome`) plus debug arrays gated by a `want_climate_debug` flag threaded through the Tauri commands. `mesh.ts` exposes them as buffer attributes; `planet.glsl.ts` reads biome+climate varyings and does ZERO climate math.

**Tech Stack:** Rust (glam `Vec3`, `hayba_tectonics_v2` `Grid`/`Model`/`Field`), `cargo test`; Tauri 2 commands; Three.js r0.169 `ShaderMaterial`; TS `tsc`. Spec: `docs/superpowers/specs/2026-05-15-climate-biome-engine-design.md`.

**Conventions:** no `Co-Authored-By: Claude` trailer; commit on the current branch `chore/repo-restructure`; stage only named files (the repo has unrelated dirty files — never `git add -A`).

**Key existing API (verified):**
- `model.grid.n_fields() -> u32`, `model.grid.position(fid: u32) -> glam::Vec3`, `model.grid.neighbours(fid: u32) -> &[u32]`, `model.grid.field_area_km2() -> f32`.
- `model.fields[fid as usize]` is a `Field` with `.elevation: f32`, `.is_continent_crust() -> bool`.
- `model.master_seed: u64` (used elsewhere in `wizard.rs`).
- `snapshot_model(model: &Model, divisions: u32) -> PlanetSnapshot` in `src/planet.rs` builds all `cell_*` arrays; called by `bake_from_wizard` and `step_planet` in `src/wizard.rs`.
- Existing helper pattern: free fns `compute_slope(model, fid)`, `latitude_band(p)` in `planet.rs`.
- TS `PlanetSnapshot` interface lives in `apps/hayba-explorer/src/App.tsx`; `mesh.ts` reads `snap.cell_*` into `THREE.BufferAttribute`s via the `attrNames` list + `updateFromSnapshot`.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/hayba-explorer/src-tauri/src/climate.rs` | **NEW.** Pure climate engine: `ClimateFields`, `compute_climate`, all sub-algorithms + unit tests. |
| `apps/hayba-explorer/src-tauri/src/lib.rs` | Add `mod climate;`. |
| `apps/hayba-explorer/src-tauri/src/planet.rs` | `PlanetSnapshot` += climate fields; `snapshot_model` calls `compute_climate`; signature gains `want_climate_debug: bool`. |
| `apps/hayba-explorer/src-tauri/src/wizard.rs` | `bake_from_wizard` / `step_planet` pass the debug flag through; new param on the Tauri commands. |
| `apps/hayba-explorer/src/App.tsx` | TS `PlanetSnapshot` interface += fields; pass `wantClimateDebug` when a map mode is active. |
| `apps/hayba-explorer/src/viewport/mesh.ts` | 3 new buffer attributes; 10 biome SatMap uniforms; biome/temp/precip plumbing. |
| `apps/hayba-explorer/src/viewport/shaders/planet.glsl.ts` | Delete in-shader climate math; read biome/temp/precip; per-biome organic-noise ramp + modifier masks + ice; map-mode switch. |
| `apps/hayba-explorer/src/components/panels/SettingsPanel.tsx` | Extend `MAP_MODES` to the ~13 climate modes. |

---

## Task 1: climate.rs scaffold + latitude/insolation/base temperature

**Files:**
- Create: `apps/hayba-explorer/src-tauri/src/climate.rs`
- Modify: `apps/hayba-explorer/src-tauri/src/lib.rs` (add `mod climate;`)

- [ ] **Step 1: Add module declaration**

In `apps/hayba-explorer/src-tauri/src/lib.rs`, find the existing `mod planet;` / `mod wizard;` lines and add alongside them:

```rust
mod climate;
```

- [ ] **Step 2: Write the failing test**

Create `apps/hayba-explorer/src-tauri/src/climate.rs`:

```rust
//! Annual-mean scientific climate model. Pure function of (grid topology,
//! per-cell elevation/ocean, seed). Recomputed every sim step inside
//! `snapshot_model`, so every algorithm here is strictly O(cells).
//! Grounded in the worldbuildingpasta simplified climate model.

use glam::Vec3;
use hayba_tectonics_v2::sphere::Grid;
use hayba_tectonics_v2::model::Model;

/// Sea-level equatorial mean temperature (°C).
const T_EQUATOR: f32 = 30.0;
/// Equator→pole annual-mean cooling (°C) at sea level.
const T_LAT_DROP: f32 = 50.0;
/// Environmental lapse rate (°C per km) — worldbuildingpasta.
const LAPSE_C_PER_KM: f32 = 4.46;
/// vElevation 1.0 ≈ this many km (matches the shader's elevKm scaling).
const ELEV_KM_SCALE: f32 = 8.0;

/// Latitude in radians from a unit-sphere position (Y-up). 0 = equator,
/// ±π/2 = poles.
pub fn latitude_rad(p: Vec3) -> f32 {
    p.y.clamp(-1.0, 1.0).asin()
}

/// Annual-mean base surface temperature (°C) before continentality /
/// currents. Latitude falloff uses sin²(lat) (smooth, peaks at equator),
/// minus the elevation lapse.
pub fn base_temperature_c(p: Vec3, elevation: f32) -> f32 {
    let s = p.y.clamp(-1.0, 1.0); // sin(lat)
    let elev_km = elevation.max(0.0) * ELEV_KM_SCALE;
    T_EQUATOR - T_LAT_DROP * (s * s) - LAPSE_C_PER_KM * elev_km
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equator_warmer_than_pole() {
        let eq = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 0.0);
        let pole = base_temperature_c(Vec3::new(0.0, 1.0, 0.0), 0.0);
        assert!(eq > 25.0, "equator should be warm, got {}", eq);
        assert!(pole < 0.0, "pole should be freezing, got {}", pole);
        assert!(eq - pole > 40.0, "equator-pole gradient too small");
    }

    #[test]
    fn mountains_are_colder() {
        let lowland = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 0.0);
        let peak = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 1.0);
        assert!(lowland - peak > 30.0, "8km peak should be ~35°C colder");
    }
}
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run from `apps/hayba-explorer/src-tauri/`: `cargo test --lib climate`
Expected: compiles and the two tests PASS (the functions are defined in the same step — this task is the scaffold; the test is the spec for the math).

If it does not compile, fix imports (`hayba_tectonics_v2` crate path — confirm with `grep -rn "use hayba_tectonics_v2" src/planet.rs`).

- [ ] **Step 4: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/climate.rs apps/hayba-explorer/src-tauri/src/lib.rs
git commit -m "feat(climate): scaffold + latitude/base-temperature (lapse)"
```

---

## Task 2: Distance-to-ocean (multi-source BFS, O(cells))

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/climate.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `climate.rs`:

```rust
#[test]
fn dist_to_ocean_zero_at_ocean_and_grows_inland() {
    // Synthetic adjacency: a 1-D chain 0-1-2-3-4 where cell 0 is ocean.
    let neighbours: Vec<Vec<u32>> = vec![
        vec![1], vec![0, 2], vec![1, 3], vec![2, 4], vec![3],
    ];
    let is_ocean = vec![true, false, false, false, false];
    let d = distance_to_ocean_hops(&neighbours, &is_ocean);
    assert_eq!(d[0], 0);
    assert_eq!(d[1], 1);
    assert_eq!(d[4], 4);
}

#[test]
fn dist_to_ocean_all_ocean_is_zero() {
    let neighbours: Vec<Vec<u32>> = vec![vec![1], vec![0]];
    let is_ocean = vec![true, true];
    let d = distance_to_ocean_hops(&neighbours, &is_ocean);
    assert_eq!(d, vec![0, 0]);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib climate::tests::dist_to_ocean`
Expected: FAIL — `distance_to_ocean_hops` not found.

- [ ] **Step 3: Implement**

Add to `climate.rs` (above the `tests` module):

```rust
/// Multi-source BFS from every ocean cell simultaneously. Returns hop
/// distance to the nearest ocean per cell. O(cells): each cell is
/// enqueued/dequeued at most once. `u32::MAX` only if a land cell is
/// unreachable (no ocean at all) — callers treat that as "max inland".
pub fn distance_to_ocean_hops(neighbours: &[Vec<u32>], is_ocean: &[bool]) -> Vec<u32> {
    use std::collections::VecDeque;
    let n = neighbours.len();
    let mut dist = vec![u32::MAX; n];
    let mut q: VecDeque<u32> = VecDeque::with_capacity(n);
    for i in 0..n {
        if is_ocean[i] {
            dist[i] = 0;
            q.push_back(i as u32);
        }
    }
    while let Some(c) = q.pop_front() {
        let dc = dist[c as usize];
        for &nb in &neighbours[c as usize] {
            if dist[nb as usize] == u32::MAX {
                dist[nb as usize] = dc + 1;
                q.push_back(nb);
            }
        }
    }
    dist
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --lib climate::tests::dist_to_ocean`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/climate.rs
git commit -m "feat(climate): multi-source BFS distance-to-ocean (O(cells))"
```

---

## Task 3: Prevailing wind vectors (latitude bands)

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/climate.rs`

- [ ] **Step 1: Write the failing test**

Add to `tests`:

```rust
#[test]
fn trade_winds_blow_west_westerlies_blow_east() {
    // A point on the equator-ish at +X, slightly north (lat ~15°): trades.
    let p_trades = Vec3::new(0.966, 0.259, 0.0).normalize(); // ~15°N
    let w_trades = prevailing_wind(p_trades);
    // local east at +X (north pole +Y) points toward +Z; trades blow E→W
    // so the wind's east-component must be negative.
    let east = Vec3::new(0.0, 1.0, 0.0).cross(p_trades).normalize();
    assert!(w_trades.dot(east) < 0.0, "trades should blow westward");

    let p_west = Vec3::new(0.707, 0.707, 0.0).normalize(); // ~45°N
    let w_west = prevailing_wind(p_west);
    let east_w = Vec3::new(0.0, 1.0, 0.0).cross(p_west).normalize();
    assert!(w_west.dot(east_w) > 0.0, "westerlies should blow eastward");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib climate::tests::trade_winds`
Expected: FAIL — `prevailing_wind` not found.

- [ ] **Step 3: Implement**

```rust
/// Prevailing surface wind as a unit tangent vector at `p`
/// (worldbuildingpasta bands): trades 0–30° (E→W), westerlies 30–60°
/// (W→E), polar easterlies 60–90° (E→W). Small equatorward meridional
/// component added for realism.
pub fn prevailing_wind(p: Vec3) -> Vec3 {
    let lat_deg = latitude_rad(p).abs().to_degrees();
    let east = Vec3::new(0.0, 1.0, 0.0).cross(p).normalize_or_zero();
    let sign = if lat_deg < 30.0 {
        -1.0 // trades, E→W
    } else if lat_deg < 60.0 {
        1.0 // westerlies, W→E
    } else {
        -1.0 // polar easterlies, E→W
    };
    // Meridional drift toward the equator (Hadley return-ish), weak.
    let toward_eq = -p.y.signum();
    let north = p.cross(east).normalize_or_zero();
    (east * sign + north * toward_eq * 0.15).normalize_or_zero()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --lib climate::tests::trade_winds`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/climate.rs
git commit -m "feat(climate): prevailing wind by latitude band"
```

---

## Task 4: Ocean-current temperature anomaly (analytic gyres)

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/climate.rs`

- [ ] **Step 1: Write the failing test**

Add to `tests`:

```rust
#[test]
fn current_anomaly_bounded_and_signed() {
    // The anomaly must stay within the documented ±range and be ~0 deep
    // in continental interiors (no coastal influence).
    let coastal_west = current_temp_anomaly(
        Vec3::new(0.5, 0.7, 0.5).normalize(), 0.05);
    assert!(coastal_west.abs() <= 12.001, "anomaly out of range: {}", coastal_west);
    let deep_inland = current_temp_anomaly(
        Vec3::new(0.5, 0.7, 0.5).normalize(), 0.95);
    assert!(deep_inland.abs() < 1.0, "interior should be ~unaffected: {}", deep_inland);
}
```

(`current_temp_anomaly(p, coastalness)` — `coastalness` 0 = at coast, 1 = deep interior.)

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib climate::tests::current_anomaly`
Expected: FAIL — not found.

- [ ] **Step 3: Implement**

```rust
/// Coastal temperature anomaly (°C) from analytic subtropical gyres.
/// Warm poleward western-boundary currents (up to +12°C), cold
/// equatorward eastern-boundary currents (down to −10°C → coastal
/// deserts). `coastalness` is the normalized inland fraction (0 = coast,
/// 1 = deep interior); the effect decays to ~0 inland.
pub fn current_temp_anomaly(p: Vec3, coastalness: f32) -> f32 {
    let lat = latitude_rad(p);
    let lat_deg = lat.abs().to_degrees();
    let lon = p.z.atan2(p.x); // −π..π
    // Three ocean basins (~120° each); gyre rotation sign per hemisphere.
    let basin_phase = (lon / (std::f32::consts::PI * 2.0 / 3.0)).fract();
    // Western half of a basin → warm poleward; eastern half → cold equatorward.
    let west_side = if basin_phase < 0.5 { 1.0 } else { -1.0 };
    // Gyre strength peaks ~45–60° latitude, fades at equator and pole.
    let strength = (1.0
        - ((lat_deg - 50.0) / 40.0).powi(2))
        .clamp(0.0, 1.0);
    let warm = west_side * lat.signum() * lat.signum(); // ±1
    let raw = warm * strength * if west_side > 0.0 { 12.0 } else { -10.0 };
    let coastal = (1.0 - coastalness).clamp(0.0, 1.0);
    raw * coastal * coastal
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --lib climate::tests::current_anomaly`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/climate.rs
git commit -m "feat(climate): analytic ocean-current temperature anomaly"
```

---

## Task 5: Value-noise helper (deterministic, for organic boundaries)

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/climate.rs`

- [ ] **Step 1: Write the failing test**

Add to `tests`:

```rust
#[test]
fn vnoise_deterministic_and_bounded() {
    let a = value_noise(Vec3::new(1.2, 3.4, 5.6), 42);
    let b = value_noise(Vec3::new(1.2, 3.4, 5.6), 42);
    assert_eq!(a, b, "must be deterministic");
    for i in 0..50 {
        let v = value_noise(Vec3::new(i as f32 * 0.7, 1.3, -2.1), 7);
        assert!(v >= 0.0 && v <= 1.0, "out of [0,1]: {}", v);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib climate::tests::vnoise`
Expected: FAIL — not found.

- [ ] **Step 3: Implement**

```rust
fn hash3(x: i32, y: i32, z: i32, seed: u64) -> f32 {
    let mut h = (x as i64).wrapping_mul(374_761_393)
        ^ (y as i64).wrapping_mul(668_265_263)
        ^ (z as i64).wrapping_mul(2_147_483_647)
        ^ seed as i64;
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h = h ^ (h >> 16);
    ((h as u64 & 0xFFFF_FFFF) as f32) / 4_294_967_296.0
}

/// Trilinear value noise in [0, 1]. Deterministic given `seed`.
pub fn value_noise(p: Vec3, seed: u64) -> f32 {
    let ix = p.x.floor() as i32;
    let iy = p.y.floor() as i32;
    let iz = p.z.floor() as i32;
    let fx = p.x - ix as f32;
    let fy = p.y - iy as f32;
    let fz = p.z - iz as f32;
    let sx = fx * fx * (3.0 - 2.0 * fx);
    let sy = fy * fy * (3.0 - 2.0 * fy);
    let sz = fz * fz * (3.0 - 2.0 * fz);
    let c = |dx, dy, dz| hash3(ix + dx, iy + dy, iz + dz, seed);
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let x00 = lerp(c(0, 0, 0), c(1, 0, 0), sx);
    let x10 = lerp(c(0, 1, 0), c(1, 1, 0), sx);
    let x01 = lerp(c(0, 0, 1), c(1, 0, 1), sx);
    let x11 = lerp(c(0, 1, 1), c(1, 1, 1), sx);
    let y0 = lerp(x00, x10, sy);
    let y1 = lerp(x01, x11, sy);
    lerp(y0, y1, sz)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --lib climate::tests::vnoise`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/climate.rs
git commit -m "feat(climate): deterministic value-noise helper"
```

---

## Task 6: Precipitation (zonal + orographic + downwind sweep + continental dry)

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/climate.rs`

- [ ] **Step 1: Write the failing test**

Add to `tests`:

```rust
#[test]
fn zonal_precip_wet_itcz_dry_subtropics() {
    let itcz   = zonal_precip(0.0_f32.to_radians());
    let dry30  = zonal_precip(30.0_f32.to_radians());
    let mid55  = zonal_precip(55.0_f32.to_radians());
    assert!(itcz > dry30, "ITCZ ({}) must be wetter than 30° ({})", itcz, dry30);
    assert!(mid55 > dry30, "mid-lat ({}) wetter than 30° ({})", mid55, dry30);
    assert!((0.0..=1.0).contains(&itcz));
}

#[test]
fn continental_drying_reduces_precip_inland() {
    let coast  = continental_factor(2);   // 2 hops from ocean
    let deep   = continental_factor(60);  // far inland
    assert!(coast > deep, "coast ({}) wetter factor than interior ({})", coast, deep);
    assert!((0.0..=1.0).contains(&deep));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib climate::tests::zonal_precip`
Expected: FAIL — not found.

- [ ] **Step 3: Implement**

```rust
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Latitudinal precipitation base (worldbuildingpasta cells): wet ITCZ
/// (~0°), dry subtropics (~30°), wet mid-lats (~55–60°), dry poles.
/// Returns ~[0,1].
pub fn zonal_precip(lat_rad: f32) -> f32 {
    let d = lat_rad.abs().to_degrees();
    let itcz    = 1.0 - smoothstep(0.0, 16.0, d);
    let subtrop = 1.0 - smoothstep(0.0, 12.0, (d - 30.0).abs());
    let midlat  = 1.0 - smoothstep(0.0, 14.0, (d - 58.0).abs());
    let polar   = smoothstep(62.0, 82.0, d);
    (0.85 * itcz - 0.6 * subtrop + 0.55 * midlat - 0.4 * polar + 0.35)
        .clamp(0.0, 1.0)
}

/// Continental drying multiplier from ocean hop-distance. Coast → ~1,
/// deep interior → ~0.25. (Onshore moisture penetrates ~2500 km;
/// approximated in hops via the caller's km scaling, but the curve here
/// is in hops with a generous span so it is grid-resolution tolerant.)
pub fn continental_factor(hops_from_ocean: u32) -> f32 {
    let h = hops_from_ocean as f32;
    1.0 - 0.75 * smoothstep(2.0, 45.0, h)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --lib climate::tests::zonal_precip climate::tests::continental_drying`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/climate.rs
git commit -m "feat(climate): zonal precip bands + continental drying"
```

---

## Task 7: Whittaker biome classifier

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/climate.rs`

- [ ] **Step 1: Write the failing test**

Add to `tests`:

```rust
#[test]
fn whittaker_classifies_canonical_points() {
    // (temp °C, precip 0..1) → biome id 0..9 (see Biome enum order).
    assert_eq!(classify_biome(28.0, 0.9), BIOME_TROPICAL_RAINFOREST);
    assert_eq!(classify_biome(28.0, 0.1), BIOME_HOT_DESERT);
    assert_eq!(classify_biome(28.0, 0.45), BIOME_TROPICAL_SAVANNA);
    assert_eq!(classify_biome(12.0, 0.9), BIOME_TEMPERATE_RAINFOREST);
    assert_eq!(classify_biome(12.0, 0.2), BIOME_GRASSLAND);
    assert_eq!(classify_biome(2.0, 0.6), BIOME_BOREAL);
    assert_eq!(classify_biome(-8.0, 0.5), BIOME_TUNDRA);
    assert_eq!(classify_biome(-25.0, 0.5), BIOME_ICE);
}

#[test]
fn equatorial_peak_is_cold_not_rainforest() {
    // base_temperature_c already cools an 8km peak by ~35°C.
    let t = base_temperature_c(Vec3::new(1.0, 0.0, 0.0), 1.0);
    let b = classify_biome(t, 0.9);
    assert!(b == BIOME_TUNDRA || b == BIOME_ICE || b == BIOME_BOREAL,
            "tall equatorial peak must be a cold biome, got {}", b);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib climate::tests::whittaker`
Expected: FAIL — symbols not found.

- [ ] **Step 3: Implement**

```rust
// Biome ids — order matches the SatMap slot order in mesh.ts.
pub const BIOME_TROPICAL_RAINFOREST: u8 = 0;
pub const BIOME_TROPICAL_SAVANNA: u8 = 1;
pub const BIOME_HOT_DESERT: u8 = 2;
pub const BIOME_TEMPERATE_RAINFOREST: u8 = 3;
pub const BIOME_TEMPERATE_FOREST: u8 = 4;
pub const BIOME_WOODLAND_SHRUB: u8 = 5;
pub const BIOME_GRASSLAND: u8 = 6;
pub const BIOME_BOREAL: u8 = 7;
pub const BIOME_TUNDRA: u8 = 8;
pub const BIOME_ICE: u8 = 9;

/// Whittaker classification from annual mean temperature (°C) and
/// precipitation (0..1). Hard cut by temperature first (Köppen-style
/// thermal limits), then precipitation within the thermal band.
pub fn classify_biome(temp_c: f32, precip: f32) -> u8 {
    if temp_c < -15.0 {
        return BIOME_ICE;
    }
    if temp_c < -2.0 {
        return BIOME_TUNDRA;
    }
    if temp_c < 6.0 {
        return BIOME_BOREAL;
    }
    if temp_c < 18.0 {
        // Temperate band.
        if precip > 0.7 {
            return BIOME_TEMPERATE_RAINFOREST;
        }
        if precip > 0.4 {
            return BIOME_TEMPERATE_FOREST;
        }
        if precip > 0.2 {
            return BIOME_WOODLAND_SHRUB;
        }
        return BIOME_GRASSLAND;
    }
    // Hot band (≥18°C).
    if precip > 0.6 {
        return BIOME_TROPICAL_RAINFOREST;
    }
    if precip > 0.2 {
        return BIOME_TROPICAL_SAVANNA;
    }
    BIOME_HOT_DESERT
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --lib climate::tests::whittaker climate::tests::equatorial_peak`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/climate.rs
git commit -m "feat(climate): Whittaker 10-biome classifier"
```

---

## Task 8: `compute_climate` orchestrator + `ClimateFields`

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/climate.rs`

- [ ] **Step 1: Write the failing test**

Add to `tests`:

```rust
#[test]
fn compute_climate_smoke_on_demo_model() {
    use hayba_tectonics_v2::model::Model;
    let model = Model::new(16, 7); // small grid
    let n = model.grid.n_fields() as usize;
    let cf = compute_climate(&model, 7, true);
    assert_eq!(cf.temperature.len(), n);
    assert_eq!(cf.precip.len(), n);
    assert_eq!(cf.biome.len(), n);
    let dbg = cf.debug.expect("debug requested");
    assert_eq!(dbg.dist_to_ocean.len(), n);
    // Sanity: at least one cell classified ice or tundra somewhere cold,
    // and biome ids are in range.
    assert!(cf.biome.iter().all(|&b| b <= 9.0));
    // want_debug=false → no debug payload.
    let cf2 = compute_climate(&model, 7, false);
    assert!(cf2.debug.is_none());
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib climate::tests::compute_climate_smoke`
Expected: FAIL — `compute_climate`/`ClimateFields` not found.

- [ ] **Step 3: Implement**

Add to `climate.rs`:

```rust
/// Always-shipped per-cell climate output (floats for direct upload as
/// Three.js buffer attributes; biome id stored as f32).
pub struct ClimateFields {
    pub temperature: Vec<f32>, // °C
    pub precip: Vec<f32>,      // 0..1
    pub biome: Vec<f32>,       // biome id 0..9 as f32
    pub debug: Option<ClimateDebug>,
}

/// Inspectable intermediates (only when `want_debug`). One f32 per cell
/// each; wind packed as (x,y,z) triples.
pub struct ClimateDebug {
    pub insolation: Vec<f32>,
    pub base_temp: Vec<f32>,
    pub dist_to_ocean: Vec<f32>,    // km
    pub wind: Vec<f32>,             // n*3
    pub current_dt: Vec<f32>,
    pub orographic: Vec<f32>,
    pub continental_dry: Vec<f32>,
}

/// Run the full annual-mean climate model. O(cells): one BFS + per-cell
/// analytic passes + one bounded orographic neighbour read.
pub fn compute_climate(model: &Model, seed: u64, want_debug: bool) -> ClimateFields {
    let grid = &model.grid;
    let n = grid.n_fields() as usize;

    // Per-cell statics.
    let mut pos: Vec<Vec3> = Vec::with_capacity(n);
    let mut elev: Vec<f32> = Vec::with_capacity(n);
    let mut is_ocean: Vec<bool> = Vec::with_capacity(n);
    for fid in 0..n as u32 {
        let p = grid.position(fid);
        let f = &model.fields[fid as usize];
        pos.push(p);
        elev.push(f.elevation);
        is_ocean.push(!f.is_continent_crust() || f.elevation < 0.0);
    }

    // Adjacency snapshot for the BFS.
    let neighbours: Vec<Vec<u32>> =
        (0..n as u32).map(|fid| grid.neighbours(fid).to_vec()).collect();
    let hops = distance_to_ocean_hops(&neighbours, &is_ocean);

    // km per hop ≈ sqrt(mean field area).
    let km_per_hop = grid.field_area_km2().sqrt();
    let max_hop = (*hops.iter().filter(|&&h| h != u32::MAX).max().unwrap_or(&1)).max(1);

    let mut temperature = vec![0.0f32; n];
    let mut precip = vec![0.0f32; n];
    let mut biome = vec![0.0f32; n];

    let mut dbg = if want_debug {
        Some(ClimateDebug {
            insolation: vec![0.0; n],
            base_temp: vec![0.0; n],
            dist_to_ocean: vec![0.0; n],
            wind: vec![0.0; n * 3],
            current_dt: vec![0.0; n],
            orographic: vec![0.0; n],
            continental_dry: vec![0.0; n],
        })
    } else {
        None
    };

    for i in 0..n {
        let p = pos[i];
        let lat = latitude_rad(p);
        let coastalness = if hops[i] == u32::MAX {
            1.0
        } else {
            (hops[i] as f32 / max_hop as f32).clamp(0.0, 1.0)
        };

        let base_t = base_temperature_c(p, elev[i]);
        let cur_dt = current_temp_anomaly(p, coastalness);
        let cont_cool = coastalness * 6.0; // interiors run colder (annual proxy)
        let t = base_t + cur_dt - cont_cool;
        temperature[i] = t;

        // Orographic: elevation gradient along the wind (bounded — one
        // neighbour read). Windward (rising into wind) wet, leeward dry.
        let wind = prevailing_wind(p);
        let mut up_grad = 0.0f32;
        for &nb in &neighbours[i] {
            let to_nb = (pos[nb as usize] - p).normalize_or_zero();
            let de = elev[nb as usize] - elev[i];
            up_grad += de * to_nb.dot(wind);
        }
        let orographic = (up_grad * 6.0).clamp(-1.0, 1.0);

        let zonal = zonal_precip(lat);
        let cont = continental_factor(if hops[i] == u32::MAX { max_hop } else { hops[i] });
        let pn = value_noise(p * 3.5, seed) - 0.5;
        let pr = (zonal * cont + orographic * 0.5 + pn * 0.25).clamp(0.0, 1.0);
        precip[i] = pr;

        biome[i] = classify_biome(t, pr) as f32;

        if let Some(d) = dbg.as_mut() {
            d.insolation[i] = (1.0 - (p.y * p.y)).clamp(0.0, 1.0);
            d.base_temp[i] = base_t;
            d.dist_to_ocean[i] = if hops[i] == u32::MAX {
                max_hop as f32 * km_per_hop
            } else {
                hops[i] as f32 * km_per_hop
            };
            d.wind[i * 3] = wind.x;
            d.wind[i * 3 + 1] = wind.y;
            d.wind[i * 3 + 2] = wind.z;
            d.current_dt[i] = cur_dt;
            d.orographic[i] = orographic;
            d.continental_dry[i] = 1.0 - cont;
        }
    }

    ClimateFields { temperature, precip, biome, debug: dbg }
}
```

- [ ] **Step 4: Run to verify it passes + full climate suite**

Run: `cargo test --lib climate`
Expected: ALL climate tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/climate.rs
git commit -m "feat(climate): compute_climate orchestrator + ClimateFields"
```

---

## Task 9: Wire climate into `PlanetSnapshot` + `snapshot_model`

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/planet.rs`
- Modify: `apps/hayba-explorer/src-tauri/src/wizard.rs`

- [ ] **Step 1: Write the failing test**

In `planet.rs` `mod tests`, add:

```rust
#[test]
fn snapshot_has_climate_fields() {
    let snap = bake_demo();
    let n = snap.n_cells as usize;
    assert_eq!(snap.cell_temperature.len(), n);
    assert_eq!(snap.cell_precip.len(), n);
    assert_eq!(snap.cell_biome.len(), n);
    assert!(snap.cell_biome.iter().all(|&b| (0.0..=9.0).contains(&b)));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --lib planet::tests::snapshot_has_climate`
Expected: FAIL — `cell_temperature` etc. not on the struct.

- [ ] **Step 3: Extend the struct + snapshot_model**

In `planet.rs`, add to the END of the `PlanetSnapshot` struct (after `cell_mor_age_steps`):

```rust
    /// Annual-mean surface temperature (°C). Recomputed every step.
    pub cell_temperature: Vec<f32>,
    /// Annual precipitation, normalized 0..1.
    pub cell_precip: Vec<f32>,
    /// Whittaker biome id (0..9) as f32 for buffer-attribute upload.
    pub cell_biome: Vec<f32>,
    /// Climate debug fields — empty unless `want_climate_debug`.
    #[serde(default)]
    pub climate_debug: ClimateDebugWire,
```

Add this serializable wire struct near `PlanetSnapshot` (top of `planet.rs`, after imports):

```rust
use serde::Serialize;

#[derive(Debug, Serialize, Default)]
pub struct ClimateDebugWire {
    pub insolation: Vec<f32>,
    pub base_temp: Vec<f32>,
    pub dist_to_ocean: Vec<f32>,
    pub wind: Vec<f32>,
    pub current_dt: Vec<f32>,
    pub orographic: Vec<f32>,
    pub continental_dry: Vec<f32>,
}
```

Change the `snapshot_model` signature:

```rust
pub fn snapshot_model(model: &Model, divisions: u32, want_climate_debug: bool) -> PlanetSnapshot {
```

Inside `snapshot_model`, AFTER the per-cell loop and BEFORE building the `PlanetSnapshot { .. }` literal, add:

```rust
    let cf = crate::climate::compute_climate(model, model.master_seed, want_climate_debug);
    let climate_debug = match cf.debug {
        Some(d) => ClimateDebugWire {
            insolation: d.insolation,
            base_temp: d.base_temp,
            dist_to_ocean: d.dist_to_ocean,
            wind: d.wind,
            current_dt: d.current_dt,
            orographic: d.orographic,
            continental_dry: d.continental_dry,
        },
        None => ClimateDebugWire::default(),
    };
```

Add to the `PlanetSnapshot { .. }` literal (end):

```rust
        cell_temperature: cf.temperature,
        cell_precip: cf.precip,
        cell_biome: cf.biome,
        climate_debug,
```

- [ ] **Step 4: Fix all `snapshot_model` call sites**

Run: `grep -rn "snapshot_model(" apps/hayba-explorer/src-tauri/src`
Every call (`bake_demo` in `planet.rs`, `bake_from_wizard` + `step_planet` in `wizard.rs`) must pass the new bool. For `bake_demo` and `bake_from_wizard` pass `true` (one-time, debug cheap & useful immediately). For `step_planet` thread a parameter (Task 10). For now make all call sites compile by passing `true` in `bake_demo`/`bake_from_wizard` and `true` in `step_planet` (Task 10 makes it conditional).

Example edits — in `wizard.rs` `bake_from_wizard`:
```rust
    let snap = snapshot_model(&model, draft.divisions, true);
```
in `step_planet`:
```rust
    Ok(snapshot_model(&state.model, state.divisions, true))
```
in `planet.rs` `bake_demo` final line:
```rust
    snapshot_model(&model, DEMO_DIVISIONS, true)
```
Also fix `bake_impl` in `wizard.rs` `#[cfg(test)]` and any `apply_boundary_types`/`apply_density_rank` that call `snapshot_model` — pass `false` there (no debug needed for those return paths).

- [ ] **Step 5: Run tests**

Run: `cargo test --lib`
Expected: ALL pass including `snapshot_has_climate_fields` and existing wizard tests.

- [ ] **Step 6: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/planet.rs apps/hayba-explorer/src-tauri/src/wizard.rs
git commit -m "feat(climate): wire compute_climate into snapshot_model (runs every step)"
```

---

## Task 10: Thread `want_climate_debug` through the Tauri commands

**Files:**
- Modify: `apps/hayba-explorer/src-tauri/src/wizard.rs`

- [ ] **Step 1: Add the param to `step_planet` and `bake_from_wizard`**

In `wizard.rs`, change the `#[tauri::command] pub fn step_planet` signature to accept `want_climate_debug: bool` and pass it to `snapshot_model`:

```rust
#[tauri::command]
pub fn step_planet(
    n_steps: u32,
    want_climate_debug: bool,
    sim: State<'_, ManagedSim>,
) -> Result<PlanetSnapshot, String> {
    let mut guard = sim.0.lock().map_err(|_| "sim mutex poisoned".to_string())?;
    let state = guard.as_mut().ok_or_else(|| "no baked planet".to_string())?;
    for _ in 0..n_steps {
        state.model.step(state.dt_ma);
    }
    Ok(snapshot_model(&state.model, state.divisions, want_climate_debug))
}
```

Do the same for `bake_from_wizard` (add `want_climate_debug: bool` param, pass through). Leave `apply_boundary_types`/`apply_density_rank` calling `snapshot_model(.., false)`.

- [ ] **Step 2: Build the Rust side**

Run: `cargo build --lib` (from `src-tauri/`)
Expected: compiles.

- [ ] **Step 3: Update every JS `invoke(` call site**

Run: `grep -rn "invoke<PlanetSnapshot>(\"step_planet\"\|invoke<PlanetSnapshot>(\"bake_from_wizard\"\|invoke(\"step_planet\"\|invoke(\"bake_from_wizard\"" apps/hayba-explorer/src`
Add `wantClimateDebug` to each invoke args object. The value = `mapModeRef.current !== 0` (a ref mirroring the `mapMode` state so the bake/step closures see the current value without re-subscribing). Add near the other refs in `App.tsx`:

```tsx
const mapModeRef = useRef(0);
useEffect(() => { mapModeRef.current = mapMode; }, [mapMode]);
```

Then each `invoke("step_planet", { nSteps, sim })` becomes `invoke("step_planet", { nSteps, wantClimateDebug: mapModeRef.current !== 0 })` (Tauri camelCases automatically; match the existing arg style in the file — if existing calls use `n_steps` keep snake, if `nSteps` keep camel; just add `wantClimateDebug`).

- [ ] **Step 4: tsc**

Run from `apps/hayba-explorer/`: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src-tauri/src/wizard.rs apps/hayba-explorer/src/App.tsx
git commit -m "feat(climate): gate debug payload behind want_climate_debug (map-mode active)"
```

---

## Task 11: TS `PlanetSnapshot` interface + mesh.ts buffer attributes

**Files:**
- Modify: `apps/hayba-explorer/src/App.tsx` (PlanetSnapshot interface)
- Modify: `apps/hayba-explorer/src/viewport/mesh.ts`

- [ ] **Step 1: Extend the TS interface**

In `App.tsx`, find `interface PlanetSnapshot` (or `export interface PlanetSnapshot`). Add:

```ts
  cell_temperature: number[];
  cell_precip: number[];
  cell_biome: number[];
  climate_debug: {
    insolation: number[];
    base_temp: number[];
    dist_to_ocean: number[];
    wind: number[];
    current_dt: number[];
    orographic: number[];
    continental_dry: number[];
  };
```

- [ ] **Step 2: Add buffer attributes in mesh.ts**

In `mesh.ts`, the `attrNames` array currently lists `"elevation","slope",...`. Add `"biome"`, `"temperature"`, `"precip"`, **and the climate-debug scalar fields** so every mask is inspectable as a map mode: `"insolation"`, `"baseTemp"`, `"distToOcean"`, `"currentDt"`, `"orographic"`, `"continentalDry"`. (Wind is a vec3 — skip as a buffer attr for now; it's directional and the orographic mask already shows its effect.) In `updateFromSnapshot`, after the existing `attrs.X.set(...)` lines add:

```ts
    attrs.biome.set(snap.cell_biome);
    attrs.temperature.set(snap.cell_temperature);
    attrs.precip.set(snap.cell_precip);
    const cd = snap.climate_debug;
    const dbgLen = snap.cell_biome.length;
    const z = new Array(dbgLen).fill(0);
    attrs.insolation.set(cd.insolation.length ? cd.insolation : z);
    attrs.baseTemp.set(cd.base_temp.length ? cd.base_temp : z);
    attrs.distToOcean.set(cd.dist_to_ocean.length ? cd.dist_to_ocean : z);
    attrs.currentDt.set(cd.current_dt.length ? cd.current_dt : z);
    attrs.orographic.set(cd.orographic.length ? cd.orographic : z);
    attrs.continentalDry.set(cd.continental_dry.length ? cd.continental_dry : z);
```

(`climate_debug` arrays are empty when `want_climate_debug` was false — the `.length ? : z` guard keeps the buffers correctly sized. The generic `attrNames` loop already creates the `Float32Array` + `BufferAttribute` + sets `needsUpdate`; just adding the names + the `.set` calls is sufficient — mirror exactly how `elevation` is handled.)

- [ ] **Step 3: tsc**

Run from `apps/hayba-explorer/`: `npx tsc --noEmit`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add apps/hayba-explorer/src/App.tsx apps/hayba-explorer/src/viewport/mesh.ts
git commit -m "feat(climate): TS snapshot interface + biome/temp/precip buffer attrs"
```

---

## Task 12: Vertex shader — biome/temp/precip attributes → varyings

**Files:**
- Modify: `apps/hayba-explorer/src/viewport/shaders/planet.glsl.ts`

- [ ] **Step 1: Add attributes + varyings**

In `VERTEX_SHADER`, alongside the existing `attribute float elevation; ...`, add (the 3 core fields + the 6 debug-mask fields so every mask is inspectable):

```glsl
  attribute float biome;
  attribute float temperature;
  attribute float precip;
  attribute float insolation;
  attribute float baseTemp;
  attribute float distToOcean;
  attribute float currentDt;
  attribute float orographic;
  attribute float continentalDry;
```

and varyings:

```glsl
  varying float vBiome;
  varying float vTemperature;
  varying float vPrecip;
  varying float vInsolation;
  varying float vBaseTemp;
  varying float vDistToOcean;
  varying float vCurrentDt;
  varying float vOrographic;
  varying float vContinentalDry;
```

In `main()` of the vertex shader, alongside `vElevation = elevation;` add:

```glsl
    vBiome = biome;
    vTemperature = temperature;
    vPrecip = precip;
    vInsolation = insolation;
    vBaseTemp = baseTemp;
    vDistToOcean = distToOcean;
    vCurrentDt = currentDt;
    vOrographic = orographic;
    vContinentalDry = continentalDry;
```

In `FRAGMENT_SHADER`, add the matching varyings (all 9):

```glsl
  varying float vBiome;
  varying float vTemperature;
  varying float vPrecip;
  varying float vInsolation;
  varying float vBaseTemp;
  varying float vDistToOcean;
  varying float vCurrentDt;
  varying float vOrographic;
  varying float vContinentalDry;
```

- [ ] **Step 2: tsc (it's a TS template string)**

Run from `apps/hayba-explorer/`: `npx tsc --noEmit`
Expected: passes (no GLSL compile here; runtime-validated in Task 14).

- [ ] **Step 3: Commit**

```bash
git add apps/hayba-explorer/src/viewport/shaders/planet.glsl.ts
git commit -m "feat(climate): pass biome/temperature/precip to the fragment shader"
```

---

## Task 13: Fragment shader — biome SatMap ramps + modifier masks + map modes; mesh uniforms

**Files:**
- Modify: `apps/hayba-explorer/src/viewport/shaders/planet.glsl.ts`
- Modify: `apps/hayba-explorer/src/viewport/mesh.ts`
- Modify: `apps/hayba-explorer/src/components/panels/SettingsPanel.tsx`

- [ ] **Step 1: Wire 10 biome SatMap uniforms in mesh.ts**

In `mesh.ts` uniforms, replace the `uSatTropical/uSatArid/uSatTemperate/uSatPolar` block with 10 biome slots (ids match `climate.rs` constants), using the existing `pick(preferred[], fallback)` helper:

```ts
      uBiome0: { value: pick(["tropical_wet_basin","tropical_wet_orogeny"], "tropical_wet_basin") },   // rainforest
      uBiome1: { value: pick(["tropical_dry_craton","tropical_dry_rift"], "tropical_dry_craton") },     // savanna
      uBiome2: { value: pick(["arid_hot_dunes","arid_hot_craton"], "arid_hot_dunes") },                 // hot desert
      uBiome3: { value: pick(["temperate_humid_coast"], "temperate_humid_coast") },                     // temp rainforest
      uBiome4: { value: pick(["temperate_humid_orogeny","temperate_humid_old_mountain"], "temperate_humid_orogeny") }, // temp forest
      uBiome5: { value: pick(["temperate_med"], "temperate_med") },                                     // woodland/shrub
      uBiome6: { value: pick(["continental_steppe","arid_cold_steppe"], "continental_steppe") },        // grassland
      uBiome7: { value: pick(["continental_shield"], "continental_shield") },                           // boreal
      uBiome8: { value: pick(["polar_tundra"], "polar_tundra") },                                       // tundra
      uBiome9: { value: pick(["polar_icecap"], "polar_icecap") },                                       // ice
      uSatMapRock: { value: pick(["arid_hot_orogeny","continental_orogeny"], "continental_orogeny") },
```

Keep `uSatMap`, `uClimateBlend`, `uMapMode`, lighting/ocean uniforms as-is. Remove the now-dead `uSatTropical/uSatArid/uSatTemperate/uSatPolar` keys.

- [ ] **Step 2: Replace the shader colour block**

In `FRAGMENT_SHADER`, declare the 10 samplers + remove the 4 old ones:

```glsl
  uniform sampler2D uBiome0; uniform sampler2D uBiome1; uniform sampler2D uBiome2;
  uniform sampler2D uBiome3; uniform sampler2D uBiome4; uniform sampler2D uBiome5;
  uniform sampler2D uBiome6; uniform sampler2D uBiome7; uniform sampler2D uBiome8;
  uniform sampler2D uBiome9;
```

Add a biome-sampler dispatch helper (after `sampleGradient`):

```glsl
  vec3 sampleBiome(float id, float h) {
    int b = int(id + 0.5);
    if (b == 0) return sampleGradient(uBiome0, h);
    if (b == 1) return sampleGradient(uBiome1, h);
    if (b == 2) return sampleGradient(uBiome2, h);
    if (b == 3) return sampleGradient(uBiome3, h);
    if (b == 4) return sampleGradient(uBiome4, h);
    if (b == 5) return sampleGradient(uBiome5, h);
    if (b == 6) return sampleGradient(uBiome6, h);
    if (b == 7) return sampleGradient(uBiome7, h);
    if (b == 8) return sampleGradient(uBiome8, h);
    return sampleGradient(uBiome9, h);
  }
  vec3 biomeDebugColor(float id) {
    int b = int(id + 0.5);
    if (b == 0) return vec3(0.05,0.45,0.10);
    if (b == 1) return vec3(0.75,0.78,0.30);
    if (b == 2) return vec3(0.85,0.62,0.30);
    if (b == 3) return vec3(0.06,0.55,0.35);
    if (b == 4) return vec3(0.15,0.55,0.20);
    if (b == 5) return vec3(0.55,0.60,0.30);
    if (b == 6) return vec3(0.70,0.72,0.42);
    if (b == 7) return vec3(0.10,0.35,0.30);
    if (b == 8) return vec3(0.55,0.50,0.45);
    return vec3(0.95,0.97,1.00);
  }
```

**Why soft weights, not the categorical id:** `vBiome` is an interpolated *categorical* id — `int(vBiome+0.5)` across a triangle stair-steps and, worse, an interpolated id between non-adjacent biomes (e.g. desert id 2 next to boreal id 7 → "4.5") samples a wrong biome. Instead, re-derive **soft** biome membership in the shader from the interpolated **continuous** fields `vTemperature`/`vPrecip` (valid to interpolate) using the SAME Whittaker thresholds as `climate.rs` (mirrored constants — trivial; the heavy spatial science stays in Rust). Categorical `vBiome` is used ONLY for the biome map-mode.

Replace the ENTIRE in-shader climate block (everything from `// ── Climate model (worldbuildingpasta-grounded...)` through the `vec3 rock = sampleGradient(uSatMapRock, ...)` / `float moisture = precip;` lines added in commit `e7b5bd9`) with:

```glsl
    // ── Colour = f(biome, organic noise) ONLY (spec core invariant) ─────
    // Climate precomputed in Rust (vTemperature °C, vPrecip 0..1). Soft
    // biome weights are re-derived here from the INTERPOLATED CONTINUOUS
    // climate (valid to lerp) using the same Whittaker cuts as climate.rs.
    // The SatMap ramp is indexed by DOMAIN-WARPED ORGANIC NOISE — never a
    // smooth radial scalar — so contour rings are impossible.
    vec3 cwarp = vec3(fbm(vWorldNormal*2.0+5.2), fbm(vWorldNormal*2.0+19.7),
                      fbm(vWorldNormal*2.0+37.1));
    float organic = fbm(vWorldNormal * 5.0 + cwarp * 1.6) * 0.6
                  + fbm(vWorldNormal * 13.0)              * 0.4;
    float warpT = vTemperature + (fbm(vWorldNormal*7.0) - 0.5) * 4.0;   // organic biome edges
    float warpP = clamp(vPrecip  + (fbm(vWorldNormal*7.0+13.0) - 0.5) * 0.18, 0.0, 1.0);

    // Whittaker soft weights — MIRRORS climate.rs classify_biome() cuts,
    // smoothstep'd so boundaries crossfade organically (no hard edges,
    // no 4-way mud: at most two adjacent biomes overlap in any band).
    float wIce  = 1.0 - smoothstep(-15.0, -13.0, warpT);
    float wTun  = smoothstep(-15.0,-13.0,warpT) * (1.0 - smoothstep(-2.0,0.0,warpT));
    float wBor  = smoothstep(-2.0,0.0,warpT)    * (1.0 - smoothstep(6.0,8.0,warpT));
    float warm  = smoothstep(6.0,8.0,warpT);
    float hot   = smoothstep(16.0,18.0,warpT);
    float temperate = warm * (1.0 - hot);
    float wTRf  = temperate * smoothstep(0.62,0.72,warpP);
    float wTF   = temperate * smoothstep(0.36,0.44,warpP) * (1.0 - smoothstep(0.62,0.72,warpP));
    float wWS   = temperate * smoothstep(0.16,0.24,warpP) * (1.0 - smoothstep(0.36,0.44,warpP));
    float wGr   = temperate * (1.0 - smoothstep(0.16,0.24,warpP));
    float wRf   = hot * smoothstep(0.55,0.65,warpP);
    float wSav  = hot * smoothstep(0.16,0.24,warpP) * (1.0 - smoothstep(0.55,0.65,warpP));
    float wDes  = hot * (1.0 - smoothstep(0.16,0.24,warpP));

    // Ice ramp is tight/low-contrast → smooth near-white pole.
    float hIce  = 0.30 + organic * 0.12;
    float hLand = clamp(organic, 0.04, 0.96);

    vec3 base =
        sampleGradient(uBiome0, hLand) * wRf
      + sampleGradient(uBiome1, hLand) * wSav
      + sampleGradient(uBiome2, hLand) * wDes
      + sampleGradient(uBiome3, hLand) * wTRf
      + sampleGradient(uBiome4, hLand) * wTF
      + sampleGradient(uBiome5, hLand) * wWS
      + sampleGradient(uBiome6, hLand) * wGr
      + sampleGradient(uBiome7, hLand) * wBor
      + sampleGradient(uBiome8, hLand) * wTun
      + sampleGradient(uBiome9, hIce)  * wIce;
    float wSum = wRf+wSav+wDes+wTRf+wTF+wWS+wGr+wBor+wTun+wIce + 1e-4;
    base /= wSum;

    vec3 rock = sampleGradient(uSatMapRock, clamp(organic * 1.1, 0.04, 0.96));
```

> Within any temperature band at most two precip-adjacent biomes have nonzero weight (the smoothsteps partition the axis), so this is a 2-way organic crossfade, never the old 4-way grey-mud average. `sampleBiome()` (categorical) is still defined for the biome map-mode in Step 3.

The downstream `rockMask`, beach, ocean, snow, lighting code stays. The old `vec3 albedo = mix(base, rock, rockMask);` line still works (`base`/`rock` defined above). Delete any now-unused leftover (`climateBase`, `bw`, `tempC`, `precip` locals, `moisture` alias) — `grep -n "climateBase\|\bbw\b\|tempC\|moisture" planet.glsl.ts` and remove dead refs (the ice/snow block used `tempLand` which is independent — keep it, but you may now drive snow from `vTemperature`: replace the `tempLand` formula with `float tempLand = vTemperature;` since Rust now provides real °C).

- [ ] **Step 3: Update the map-mode debug switch**

Replace the existing `if (uMapMode > 0.5) { ... }` block with the FULL mask set (every climate stage inspectable — user requirement):

```glsl
    if (uMapMode > 0.5) {
      vec3 d;
      if      (uMapMode < 1.5)  d = vec3(clamp((vTemperature + 25.0) / 60.0, 0.0, 1.0));      // temperature
      else if (uMapMode < 2.5)  d = mix(vec3(0.32,0.22,0.05), vec3(0.05,0.25,0.95), vPrecip);  // precipitation
      else if (uMapMode < 3.5)  d = biomeDebugColor(vBiome);                                   // biome (argmax)
      else if (uMapMode < 4.5)  d = vec3(clamp(max(vElevation,0.0),0.0,1.0));                  // elevation
      else if (uMapMode < 5.5)  d = vec3(clamp(vSlope,0.0,1.0));                               // slope
      else if (uMapMode < 6.5)  d = vec3(0.0,0.35,0.95) * oceanMask;                           // ocean mask
      else if (uMapMode < 7.5)  d = vec3(clamp(vInsolation,0.0,1.0));                          // insolation
      else if (uMapMode < 8.5)  d = vec3(clamp((vBaseTemp + 25.0)/60.0,0.0,1.0));              // base temp (pre current/continental)
      else if (uMapMode < 9.5)  d = vec3(clamp(vDistToOcean / 4000.0,0.0,1.0));                // distance-to-ocean (km, ~4000 full)
      else if (uMapMode < 10.5) d = mix(vec3(0.1,0.1,0.9), vec3(0.95,0.3,0.1),                 // ocean-current ΔT
                                        clamp(vCurrentDt*0.05 + 0.5, 0.0, 1.0));               //   blue=cold .. red=warm
      else if (uMapMode < 11.5) d = mix(vec3(0.85,0.55,0.15), vec3(0.1,0.5,0.95),              // orographic
                                        clamp(vOrographic*0.5 + 0.5, 0.0, 1.0));               //   dry leeward .. wet windward
      else                      d = vec3(clamp(vContinentalDry,0.0,1.0));                      // continental dryness
      gl_FragColor = vec4(linearToSrgb(d), 1.0);
      return;
    }
```

- [ ] **Step 4: Set `MAP_MODES` in SettingsPanel (full mask set)**

```ts
export const MAP_MODES: { value: number; label: string }[] = [
  { value: 0,  label: "Final render" },
  { value: 1,  label: "Temperature" },
  { value: 2,  label: "Precipitation" },
  { value: 3,  label: "Biome" },
  { value: 4,  label: "Elevation" },
  { value: 5,  label: "Slope" },
  { value: 6,  label: "Ocean mask" },
  { value: 7,  label: "Insolation" },
  { value: 8,  label: "Base temp" },
  { value: 9,  label: "Distance to ocean" },
  { value: 10, label: "Ocean current ΔT" },
  { value: 11, label: "Orographic (rain shadow)" },
  { value: 12, label: "Continental dryness" },
];
```

- [ ] **Step 5: tsc + Rust build**

Run from `apps/hayba-explorer/`: `npx tsc --noEmit`
Run from `src-tauri/`: `cargo build --lib`
Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/hayba-explorer/src/viewport/shaders/planet.glsl.ts apps/hayba-explorer/src/viewport/mesh.ts apps/hayba-explorer/src/components/panels/SettingsPanel.tsx
git commit -m "feat(climate): shader reads biome/temp/precip; per-biome organic-noise ramps; map modes"
```

---

## Task 14: Manual visual validation + success-criteria checklist

**Files:** none (validation only).

> No automated UI test exists; per project policy, viewport correctness is validated visually. Type/cargo checks verify code correctness, not feature correctness.

- [ ] **Step 1: Build & run**

Run from `apps/hayba-explorer/`: `npm run tauri dev`

- [ ] **Step 2: Validate the science via map modes (spec order)**

Bake a planet. Settings ▸ Diagnostics:
- **Temperature**: smooth white-equator → dark-poles, dipping on mountains.
- **Precipitation**: wet equatorial/ITCZ + mid-lat bands, dry ~30° belts, visibly drier continental interiors, rain-shadow asymmetry across ranges.
- **Biome (argmax)**: reads like an Earth biome map — green equatorial belt, ~30° desert belts, mid-lat forests, white poles. **Gate: if this is wrong, the science is wrong — stop and report which field looks off.**

- [ ] **Step 3: Validate the render (success criteria from spec §Success criteria)**

Switch to Final render, bake several seeds, and confirm:
1. No contour rings at any elevation/zoom.
2. ≥5 visually distinct greens; no neon-orange artifacts.
3. Visible rain shadows / dry interiors / coastal deserts.
4. Smooth near-white poles, rocky fringe, no grey mottle.
5. Step the sim — biomes drift with continents (climate re-syncs every step).

Capture a screenshot of biome mode + final render to `docs/research/climate-engine-validation-2026-05-15.png`.

- [ ] **Step 4: Full test sweep**

Run from `src-tauri/`: `cargo test --lib` → all pass.
Run from `apps/hayba-explorer/`: `npx tsc --noEmit` → passes.

- [ ] **Step 5: Commit the validation artifact**

```bash
git add docs/research/climate-engine-validation-2026-05-15.png
git commit -m "test(climate): visual validation artifact + success-criteria pass"
```

---

## Task 15: mesh.ts — per-biome SatMap reassignment hook

**Files:**
- Modify: `apps/hayba-explorer/src/viewport/mesh.ts`

The 10 biome SatMap uniforms `uBiome0..uBiome9` exist (Task 13). Add a runtime setter so the Texturing UI can swap any slot.

- [ ] **Step 1: Add to `GlobeMeshHandle` interface**

```ts
  /** Reassign the SatMap for one biome slot (0..9). */
  setBiomeSatMap(biomeIndex: number, name: SatMapName): void;
```

- [ ] **Step 2: Implement in the returned handle**

In the `return { ... }` object (alongside `setSatMap`):

```ts
    setBiomeSatMap: (biomeIndex, name) => {
      const key = "uBiome" + biomeIndex;
      if (mat.uniforms[key]) mat.uniforms[key].value = loadSatMap(name);
    },
```

- [ ] **Step 3: tsc**

Run from `apps/hayba-explorer/`: `npx tsc --noEmit` → passes.

- [ ] **Step 4: Commit**

```bash
git add apps/hayba-explorer/src/viewport/mesh.ts
git commit -m "feat(texturing): per-biome SatMap reassignment hook on the mesh"
```

---

## Task 16: Texturing panel category — per-biome SatMap library picker

**Files:**
- Create: `apps/hayba-explorer/src/components/panels/TexturingPanel.tsx`
- Modify: `apps/hayba-explorer/src/components/CategoryStrip.tsx` (add `"texturing"` to the `PanelCategory` union + an `ITEMS` entry between `compose` and `boundaries`, reuse `ICON_URLS.categoryCompose`)
- Modify: `apps/hayba-explorer/src/components/RightPanel.tsx` (add `texturing` to the `TITLES` record: `{ title: "Texturing", subtitle: "Per-biome SatMaps" }`)
- Modify: `apps/hayba-explorer/src/App.tsx` (state, `categoryEnabled`, render)

Pattern: mirror exactly how the existing `boundaries`/`densities` categories are wired (union → ITEMS → TITLES → `categoryEnabled` → render block). Enabled post-bake (`mode === "boundaries" || mode === "densities" || mode === "simulating"`).

- [ ] **Step 1: Biome slot constants (shared)**

In `apps/hayba-explorer/src/viewport/satmap-loader.ts`, append:

```ts
/** Biome slot order — MUST match climate.rs BIOME_* ids and mesh uBiome0..9. */
export const BIOME_SLOTS: { index: number; label: string; defaultName: string }[] = [
  { index: 0, label: "Tropical rainforest", defaultName: "tropical_wet_basin" },
  { index: 1, label: "Tropical savanna",    defaultName: "tropical_dry_craton" },
  { index: 2, label: "Hot desert",          defaultName: "arid_hot_dunes" },
  { index: 3, label: "Temperate rainforest",defaultName: "temperate_humid_coast" },
  { index: 4, label: "Temperate forest",    defaultName: "temperate_humid_orogeny" },
  { index: 5, label: "Woodland / shrub",    defaultName: "temperate_med" },
  { index: 6, label: "Grassland / steppe",  defaultName: "continental_steppe" },
  { index: 7, label: "Boreal / taiga",      defaultName: "continental_shield" },
  { index: 8, label: "Tundra",              defaultName: "polar_tundra" },
  { index: 9, label: "Ice cap",             defaultName: "polar_icecap" },
];
```

- [ ] **Step 2: Create `TexturingPanel.tsx`**

```tsx
import React from "react";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import Select from "../Select";
import { SATMAP_NAMES, BIOME_SLOTS, type SatMapName } from "../../viewport/satmap-loader";

export interface TexturingPanelProps {
  assignments: Record<number, SatMapName>; // biomeIndex → SatMap name
  onAssign: (biomeIndex: number, name: SatMapName) => void;
}

export default function TexturingPanel(p: TexturingPanelProps): React.ReactElement {
  const opts = SATMAP_NAMES.map((n) => ({ value: n, label: n }));
  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <PropertySection heading="Biome SatMaps">
        {BIOME_SLOTS.map((b, i) => (
          <PropertyRow
            key={b.index}
            label={b.label}
            noSeparator={i === BIOME_SLOTS.length - 1}
            value={
              <Select<SatMapName>
                value={p.assignments[b.index] ?? b.defaultName}
                onChange={(v) => p.onAssign(b.index, v)}
                options={opts}
              />
            }
          />
        ))}
      </PropertySection>
    </div>
  );
}
```

- [ ] **Step 3: Wire into App.tsx**

Add state + handler near the other panel state:

```tsx
const [biomeAssignments, setBiomeAssignments] = useState<Record<number, string>>({});
const handleAssignBiome = useCallback((bi: number, name: string) => {
  setBiomeAssignments((m) => ({ ...m, [bi]: name }));
  globeMeshRef.current?.setBiomeSatMap(bi, name);
}, []);
```

Add `"texturing"` handling: in `categoryEnabled` set `texturing: mode === "boundaries" || mode === "densities" || mode === "simulating"`; in `categoryDisabledReason` add `texturing: "Bake the planet first"`. Render block alongside the others:

```tsx
{panelCategory === "texturing" && snapshot && (
  <TexturingPanel assignments={biomeAssignments} onAssign={handleAssignBiome} />
)}
```

Import `TexturingPanel` at the top.

- [ ] **Step 4: tsc**

Run from `apps/hayba-explorer/`: `npx tsc --noEmit` → passes.

- [ ] **Step 5: Commit**

```bash
git add apps/hayba-explorer/src/components/panels/TexturingPanel.tsx apps/hayba-explorer/src/components/CategoryStrip.tsx apps/hayba-explorer/src/components/RightPanel.tsx apps/hayba-explorer/src/App.tsx apps/hayba-explorer/src/viewport/satmap-loader.ts
git commit -m "feat(texturing): post-bake Texturing category — per-biome SatMap library picker"
```

---

## Verification checklist (definition of done)

- `cargo test --lib` green (all `climate::tests::*` + `planet::tests::snapshot_has_climate_fields` + existing wizard tests).
- `npx tsc --noEmit` clean; `cargo build --lib` clean.
- **All 12 map modes render** (temperature, precipitation, biome, elevation, slope, ocean, insolation, base-temp, distance-to-ocean, current ΔT, orographic, continental dryness) — every mask inspectable.
- **Texturing category**: post-bake, each of the 10 biome slots reassignable from the full SatMap library, change reflected live on the globe.
- Visual: no rings, ≥5 greens, no orange, smooth poles, non-zonal rain shadows, biomes drift with the sim.
- Spec success criteria 1–7 all confirmed.

After all tasks: use `superpowers:finishing-a-development-branch`.

## Out of scope

- Per-biome *texturing parameters* beyond SatMap choice (noise scale, ramp contrast sliders) — the SatMap picker covers the stated need; parameter sliders are a later polish if requested.
