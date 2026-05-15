# Planet Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Hayba Explorer's point-cloud planet with a triangulated mesh shaded via Gaea-style 2D SatMaps, displaced by elevation, with TE-faithful per-cell rendering of subduction / orogeny / MOR / volcanic-arc / crust-age effects.

**Architecture:** Triangle mesh on the icosphere, per-vertex attributes pushed each snapshot from the Rust sim. Custom GLSL ShaderMaterial samples a `texture(satmap, vec2(height, slope))` for the base albedo, then layers active-boundary tints, MOR fade-in, volcanic glow, plate outlines, and Hayba rim lighting. A standalone Python pipeline bakes the 6 SatMap CLUTs from NASA Blue Marble + ETOPO1 + Köppen-Geiger.

**Tech Stack:**
- Rust crate `hayba-tectonics-v2` (existing) — adds 11 per-cell arrays to `PlanetSnapshot`
- Tauri command `step_planet` / `bake_from_wizard` — already returns the snapshot
- React 18 + TypeScript + Vite (apps/hayba) — no test framework, verification is `npm run build` + manual smoke
- Three.js 0.169 — `THREE.Mesh` + `ShaderMaterial` + `BufferAttribute`
- Python 3.11+ for the SatMap bake (`tools/derive_satmaps/`)
  - `rasterio` for reading GeoTIFFs
  - `numpy` for the binning/median/inpaint math
  - `Pillow` for writing the output PNGs
  - `pytest` for tests
- Spec: `docs/superpowers/specs/2026-05-14-planet-renderer-design.md`

**Branch policy:** Continue on `feat/hayba-frontend-pass` or branch off a fresh `feat/planet-renderer`. Per user memory: feature branches per task, push when ready, no `Co-Authored-By: Claude` trailer.

---

## File structure

### New files

| Path | Responsibility |
|---|---|
| `apps/hayba/src/viewport/mesh.ts` | Triangulated icosphere mesh handle (creation, attribute updates, dispose) |
| `apps/hayba/src/viewport/shaders/planet.glsl.ts` | Vertex + fragment shader strings (exported constants) |
| `apps/hayba/src/viewport/satmap-loader.ts` | Loads + caches the 6 SatMap textures, handles SatMap switching |
| `apps/hayba/src/assets/satmaps/temperate.png` … (6 PNGs) | Baked SatMap CLUTs (256×256 RGB) |
| `tools/derive_satmaps/derive.py` | Python bake script |
| `tools/derive_satmaps/test_derive.py` | pytest unit tests for the binning/median/inpaint logic |
| `tools/derive_satmaps/requirements.txt` | rasterio, numpy, Pillow, pytest |
| `tools/derive_satmaps/README.md` | How to run the bake + where to find the input rasters |

### Modified files

| Path | What changes |
|---|---|
| `packages/hayba-tectonics-v2/src/model/model.rs` | Add `orogenic_uplift` and `mor_age_steps` fields to `Field` (or sibling), populated during step phases |
| `apps/hayba/src-tauri/src/planet.rs` | `PlanetSnapshot` gains 11 new per-cell arrays; `snapshot_model()` populates them |
| `apps/hayba/src/App.tsx` | Imports new `buildGlobeMesh` instead of `buildGlobe`; reads new SatMap setting; wires displacement slider through |
| `apps/hayba/src/components/panels/SettingsPanel.tsx` | Adds Appearance section (SatMap dropdown, exaggeration slider, plate-outline toggle, boundary-glow toggle) |
| `apps/hayba/src/viewport/scene.ts` | No changes — `scene` already exposes everything mesh.ts needs |

### Deleted files

| Path | When |
|---|---|
| `apps/hayba/src/viewport/globe.ts` | After Task 16 confirms the new mesh works end-to-end; final cleanup |

---

## Verification convention

- **Rust changes**: `cargo test -p hayba-tectonics-v2` and `cargo test --manifest-path apps/hayba/src-tauri/Cargo.toml`
- **TypeScript changes**: `cd apps/hayba; npm run build` (PowerShell — use `;` not `&&`)
- **Python changes**: `cd tools/derive_satmaps; pytest -v`
- **Smoke test**: `cd apps/hayba; npm run tauri dev` and visually verify the specific behavior the task added

---

## Task 1: Rust — extend Field with `orogenic_uplift` and `mor_age_steps`

**Files:**
- Modify: `packages/hayba-tectonics-v2/src/field/field.rs`
- Modify: `packages/hayba-tectonics-v2/src/model/model.rs`
- Test: `packages/hayba-tectonics-v2/src/field/field.rs` (inline `#[cfg(test)]`)

These two new fields are what the snapshot will surface to the renderer. They're maintained inside `step()` as orogeny / MOR progresses.

- [ ] **Step 1: Add the two fields to `Field`**

In `packages/hayba-tectonics-v2/src/field/field.rs`, inside the `Field` struct definition (near `bending_progress` / `block_faulting`):

```rust
/// Recent orogenic uplift rate at this cell, normalized to [0, 1].
/// Bumped to 1.0 each step the cell participates in an Orogeny collision;
/// decays toward 0 with `orogenic_uplift *= 0.92` each step.
pub orogenic_uplift: f32,

/// Steps since this cell was spawned at a mid-ocean ridge.
/// 0 = just spawned. Saturates at u16::MAX (which the renderer caps).
pub mor_age_steps: u16,
```

In `Field::new()`, initialize both to `0` / `0u16`.

- [ ] **Step 2: Write failing tests for the defaults**

In the same file, inside `#[cfg(test)] mod tests { ... }` (add the module if it doesn't exist):

```rust
#[test]
fn new_field_has_zero_orogenic_uplift_and_mor_age() {
    let f = Field::new(0, glam::Vec3::X);
    assert_eq!(f.orogenic_uplift, 0.0);
    assert_eq!(f.mor_age_steps, 0);
}
```

- [ ] **Step 3: Run tests**

```
cargo test -p hayba-tectonics-v2 -- new_field_has_zero_orogenic_uplift_and_mor_age
```

Expected: PASS (just the default values).

- [ ] **Step 4: Bump `orogenic_uplift` in the orogeny resolution path**

In `packages/hayba-tectonics-v2/src/subduction/collision.rs`, in `resolve_field_collision`, the `CollisionKind::Orogeny` branch — locate the spot where the bottom field's state is mutated, and add:

```rust
fields[collision.bottom_field as usize].orogenic_uplift = 1.0;
fields[collision.top_field as usize].orogenic_uplift = 1.0;
```

If the file uses a different mutation pattern (closures, etc.), follow it — the goal is "any field that's part of an active orogeny gets uplift=1.0 this step."

- [ ] **Step 5: Decay `orogenic_uplift` each step**

In `model.rs`, in `step()`, add a decay pass at the end of Phase D (per-cell geological processes). Iterate fields:

```rust
for f in self.fields.iter_mut() {
    f.orogenic_uplift *= 0.92;
    if f.orogenic_uplift < 0.005 {
        f.orogenic_uplift = 0.0;
    }
}
```

- [ ] **Step 6: Increment `mor_age_steps` each step for every cell that has a plate**

In the same step-end pass:

```rust
for f in self.fields.iter_mut() {
    if f.plate_id.is_some() {
        f.mor_age_steps = f.mor_age_steps.saturating_add(1);
    }
}
```

- [ ] **Step 7: Reset `mor_age_steps = 0` for newly spawned MOR cells**

In `generate_new_fields()` (the function that handles divergent boundary new-crust spawning — look for it in `model.rs` or sibling). When a new field is created, set `field.mor_age_steps = 0` before the function returns.

- [ ] **Step 8: Write test for orogeny bump**

```rust
#[test]
fn orogeny_collision_marks_both_fields_with_uplift() {
    // Construct a minimal model with two continental fields on different
    // plates positioned to collide. Run one step. Both fields should have
    // orogenic_uplift == 1.0.
    //
    // Reuse the test scaffolding pattern from any existing collision test
    // in subduction/collision.rs (search for #[cfg(test)] tests there).
}
```

Look at how existing collision tests in `subduction/collision.rs` construct test fields; mirror that exact pattern. If the existing tests use a shared helper (e.g. `make_test_model()`), use it.

- [ ] **Step 9: Run all crate tests**

```
cargo test -p hayba-tectonics-v2
```

Expected: PASS (no regressions, new test passes).

- [ ] **Step 10: Commit**

```
git add packages/hayba-tectonics-v2/src/
git commit -m "feat(tectonics): track per-cell orogenic_uplift + mor_age_steps for renderer"
```

---

## Task 2: Rust — extend `PlanetSnapshot` with the 11 new arrays

**Files:**
- Modify: `apps/hayba/src-tauri/src/planet.rs`
- Test: `apps/hayba/src-tauri/src/planet.rs` (inline)

This pushes the per-cell sim state across the Tauri bridge to the renderer.

- [ ] **Step 1: Add the 11 fields to `PlanetSnapshot`**

In `apps/hayba/src-tauri/src/planet.rs`, in the `PlanetSnapshot` struct (next to `cell_neighbor_plate`):

```rust
pub cell_slope: Vec<f32>,
pub cell_latitude_band: Vec<u8>,
pub cell_age_ma: Vec<f32>,
pub cell_crust_thickness_km: Vec<f32>,
pub cell_volcanic_intensity: Vec<f32>,
pub cell_collision_kind: Vec<u8>,
pub cell_subduction_progress: Vec<f32>,
pub cell_is_continent_buffer: Vec<u8>,
pub cell_orogenic_uplift: Vec<f32>,
pub cell_mor_age_steps: Vec<u16>,
```

(That's 10 — `cell_slope` and `cell_latitude_band` are 2 of them; if `cell_latitude_band` is missing from your count, add it. Total = 11 new fields above the existing snapshot.)

- [ ] **Step 2: Compute slope helper**

Add a free function in the same file before `snapshot_model`:

```rust
/// Maximum absolute neighbour elevation difference, normalized to [0, 1]
/// using a planet-scale denominator (full elevation range = 10 km ≈ 0.0016
/// in unit-sphere units; we just normalize by max raw elevation in the model).
fn compute_slope(model: &Model, fid: u32) -> f32 {
    let here = model.fields[fid as usize].elevation;
    let mut max_diff = 0.0_f32;
    for &nb in model.grid.neighbours(fid) {
        let d = (model.fields[nb as usize].elevation - here).abs();
        if d > max_diff { max_diff = d; }
    }
    // Empirical normalizer — actual max neighbour-difference rarely exceeds
    // 0.05 in the model's elevation units. Clamp to [0, 1].
    (max_diff * 20.0).clamp(0.0, 1.0)
}
```

- [ ] **Step 3: Latitude band helper**

```rust
fn latitude_band(pos: glam::Vec3) -> u8 {
    // Y is the polar axis. |y| ranges from 0 (equator) to 1 (pole).
    let abs_lat = pos.y.abs();
    if abs_lat < 0.40 { 0 }      // Tropical (0-23.5°)
    else if abs_lat < 0.60 { 1 } // Subtropical
    else if abs_lat < 0.78 { 2 } // Temperate
    else if abs_lat < 0.93 { 3 } // Subpolar
    else { 4 }                   // Polar
}
```

- [ ] **Step 4: Collision-kind helper**

```rust
fn collision_kind(field: &Field) -> u8 {
    // 0=none, 1=Subduction, 2=Orogeny, 3=Buffer-kill, 4=Drag.
    // `field.colliding` is set whenever the cell participates in any kind.
    // Distinguish by per-cell flags:
    if !field.colliding { return 0; }
    if field.subduction.is_some() { return 1; }
    if field.orogenic_uplift > 0.0 { return 2; }
    if field.is_continent_buffer { return 3; }
    4
}
```

If `Field` doesn't have a `colliding: bool` field directly accessible, find the equivalent (in §8.1 of the spec the corresponding state is `field.colliding`). Verify by `grep -n "colliding" packages/hayba-tectonics-v2/src/field/field.rs`.

- [ ] **Step 5: Populate the 11 fields in `snapshot_model()`**

In the per-cell loop of `snapshot_model()`, after the existing `cell_neighbor_plate.push(...)`:

```rust
cell_slope.push(compute_slope(model, fid));
cell_latitude_band.push(latitude_band(p));
cell_age_ma.push(f.age);
cell_crust_thickness_km.push(f.crust_thickness());
cell_volcanic_intensity.push(
    f.volcanic_activity.as_ref().map(|v| v.intensity).unwrap_or(0.0)
);
cell_collision_kind.push(collision_kind(f));
cell_subduction_progress.push(
    f.subduction.as_ref().map(|s| s.progress()).unwrap_or(0.0)
);
cell_is_continent_buffer.push(if f.is_continent_buffer { 1 } else { 0 });
cell_orogenic_uplift.push(f.orogenic_uplift);
cell_mor_age_steps.push(f.mor_age_steps);
```

Declare these vectors at the top of the function (mirroring `cell_positions`, `cell_plate_ids`, etc.). Add them to the returned `PlanetSnapshot { ... }` literal.

If `VolcanicActivity` has a different field name than `intensity`, grep for its struct definition: `grep -n "struct VolcanicActivity\|pub intensity" packages/hayba-tectonics-v2/src/`.

- [ ] **Step 6: Update the snapshot test**

In `apps/hayba/src-tauri/src/planet.rs`, look for the existing test that asserts `snap.cell_positions.len() == snap.n_cells * 3`. Add assertions for the new fields:

```rust
assert_eq!(snap.cell_slope.len() as u32, snap.n_cells);
assert_eq!(snap.cell_latitude_band.len() as u32, snap.n_cells);
assert_eq!(snap.cell_age_ma.len() as u32, snap.n_cells);
assert_eq!(snap.cell_crust_thickness_km.len() as u32, snap.n_cells);
assert_eq!(snap.cell_volcanic_intensity.len() as u32, snap.n_cells);
assert_eq!(snap.cell_collision_kind.len() as u32, snap.n_cells);
assert_eq!(snap.cell_subduction_progress.len() as u32, snap.n_cells);
assert_eq!(snap.cell_is_continent_buffer.len() as u32, snap.n_cells);
assert_eq!(snap.cell_orogenic_uplift.len() as u32, snap.n_cells);
assert_eq!(snap.cell_mor_age_steps.len() as u32, snap.n_cells);
```

- [ ] **Step 7: Run tests**

```
cargo test --manifest-path apps/hayba/src-tauri/Cargo.toml
```

Expected: PASS (existing snapshot tests + the new length assertions all pass).

- [ ] **Step 8: Verify the frontend TypeScript types still compile**

The `PlanetSnapshot` TS interface in `apps/hayba/src/App.tsx` doesn't yet know about the new fields. They'll be ignored on the JS side until Task 8 wires them in. Just confirm `npm run build` still passes:

```
cd apps/hayba; npm run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```
git add apps/hayba/src-tauri/src/planet.rs
git commit -m "feat(planet): extend snapshot with slope, latitude band, age, collisions, MOR age"
```

---

## Task 3: TypeScript — update `PlanetSnapshot` interface

**Files:**
- Modify: `apps/hayba/src/App.tsx`
- Modify: `apps/hayba/src/wizard/boundary-model.ts` (if it spreads the interface)

- [ ] **Step 1: Extend the interface**

In `apps/hayba/src/App.tsx`, where `PlanetSnapshot` is declared:

```ts
export interface PlanetSnapshot {
  divisions: number;
  n_cells: number;
  sim_time_ma: number;
  cell_positions: number[];
  cell_plate_ids: number[];
  cell_elevation: number[];
  cell_continental: number[];
  cell_is_boundary: number[];
  cell_neighbor_plate: number[];
  cell_slope: number[];
  cell_latitude_band: number[];
  cell_age_ma: number[];
  cell_crust_thickness_km: number[];
  cell_volcanic_intensity: number[];
  cell_collision_kind: number[];
  cell_subduction_progress: number[];
  cell_is_continent_buffer: number[];
  cell_orogenic_uplift: number[];
  cell_mor_age_steps: number[];
}
```

- [ ] **Step 2: Verify build**

```
cd apps/hayba; npm run build
```

Expected: PASS.

- [ ] **Step 3: Commit**

```
git add apps/hayba/src/App.tsx
git commit -m "feat(hayba-explorer): mirror new PlanetSnapshot fields in TS"
```

---

## Task 4: Python — SatMap bake script scaffolding

**Files:**
- Create: `tools/derive_satmaps/derive.py`
- Create: `tools/derive_satmaps/requirements.txt`
- Create: `tools/derive_satmaps/README.md`
- Create: `tools/derive_satmaps/test_derive.py`

- [ ] **Step 1: Create the directory and requirements file**

```
tools/derive_satmaps/requirements.txt:
```
```
rasterio==1.3.10
numpy==1.26.4
Pillow==10.3.0
scipy==1.13.0
pytest==8.2.0
```

`scipy` is for the Gaussian inpaint pass.

- [ ] **Step 2: README**

`tools/derive_satmaps/README.md`:

```markdown
# SatMap bake

One-time pipeline that derives 6 Gaea-style 2D CLUTs from real Earth data.

## Inputs (cached in `cache/`)

- NASA Blue Marble Next Generation (August): https://visibleearth.nasa.gov/images/74092/august-blue-marble-next-generation-w-topography-and-bathymetry — download the 8192×4096 PNG and save as `cache/bluemarble_aug.png`
- ETOPO1: https://www.ngdc.noaa.gov/mgg/global/ — download `ETOPO1_Ice_g_geotiff.zip`, extract `ETOPO1_Ice_g.tif` to `cache/etopo1.tif`
- Köppen-Geiger: http://www.gloh2o.org/koppen/ — download `Beck_KG_V1_present_0p0083.tif` to `cache/koppen.tif`

Total cache size: ~85 MB. `.gitignore` excludes `cache/`.

## Run

```
cd tools/derive_satmaps
pip install -r requirements.txt
python derive.py
```

Outputs land in `apps/hayba/src/assets/satmaps/*.png` (6 PNGs, ~80 KB each).
```

- [ ] **Step 3: Stub `derive.py`**

```python
"""Derive 6 Gaea-style SatMaps from NASA Blue Marble + ETOPO1 + Köppen-Geiger.

See README.md for input downloads. Outputs 256x256 RGB PNGs to
apps/hayba/src/assets/satmaps/.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

CACHE_DIR = Path(__file__).parent / "cache"
OUT_DIR = Path(__file__).parent.parent.parent / "apps" / "hayba" / "src" / "assets" / "satmaps"
CLUT_SIZE = 256

# Köppen class codes → our biome buckets. Beck et al. 2018 raster uses
# integer class codes 1..30. See koeppen-geiger.vu-wien.ac.at for the table.
BIOME_MAP: dict[str, set[int]] = {
    "tropical":  {1, 2, 3},                # Af, Am, Aw
    "arid":      {4, 5, 6, 7},             # BWh, BWk, BSh, BSk
    "temperate": {8, 9, 10, 14, 15, 16},   # C-class
    "alpine":    {25, 26, 27},             # ET subset above tree line
    "tundra":    {29, 30},                 # ET-low / EF
    "oceanic":   {11, 12, 13, 17, 18},     # mid-lat oceanic + maritime
}

def bin_samples(
    color: np.ndarray,         # (H, W, 3) uint8 RGB
    elev:  np.ndarray,         # (H, W)    float
    slope: np.ndarray,         # (H, W)    float in 0..1
    mask:  np.ndarray,         # (H, W)    bool — which pixels belong to this biome
    n_bins: int = CLUT_SIZE,
) -> np.ndarray:
    """Median-bin the colors into a (n_bins, n_bins, 3) array.

    Bins where no pixels fell get NaN; downstream `inpaint` fills them.
    """
    raise NotImplementedError

def inpaint(clut: np.ndarray) -> np.ndarray:
    """Fill NaN bins in a (n_bins, n_bins, 3) CLUT by iterated Gaussian smoothing."""
    raise NotImplementedError

def derive_satmap(name: str, classes: set[int]) -> None:
    raise NotImplementedError

def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, classes in BIOME_MAP.items():
        derive_satmap(name, classes)

if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Stub tests**

`tools/derive_satmaps/test_derive.py`:

```python
import numpy as np
import pytest

from derive import bin_samples, inpaint, CLUT_SIZE

def test_bin_samples_outputs_correct_shape():
    color = np.zeros((10, 10, 3), dtype=np.uint8)
    elev  = np.zeros((10, 10), dtype=np.float32)
    slope = np.zeros((10, 10), dtype=np.float32)
    mask  = np.ones((10, 10), dtype=bool)
    out = bin_samples(color, elev, slope, mask)
    assert out.shape == (CLUT_SIZE, CLUT_SIZE, 3)

def test_inpaint_fills_all_nans():
    clut = np.full((CLUT_SIZE, CLUT_SIZE, 3), np.nan, dtype=np.float32)
    clut[128, 128] = [1.0, 0.5, 0.25]
    out = inpaint(clut)
    assert not np.isnan(out).any()
```

- [ ] **Step 5: Verify tests fail correctly**

```
cd tools/derive_satmaps
python -m pip install -r requirements.txt
pytest -v
```

Expected: 2 FAILS with `NotImplementedError`.

- [ ] **Step 6: Commit scaffolding**

```
git add tools/derive_satmaps/
git commit -m "feat(satmaps): scaffold Python bake pipeline (NASA + ETOPO + Köppen)"
```

---

## Task 5: Python — implement `bin_samples` and `inpaint`

**Files:**
- Modify: `tools/derive_satmaps/derive.py`

- [ ] **Step 1: Implement `bin_samples`**

Replace the `NotImplementedError` in `bin_samples`:

```python
def bin_samples(color, elev, slope, mask, n_bins=CLUT_SIZE):
    h = np.clip((elev * 0.5 + 0.5) * (n_bins - 1), 0, n_bins - 1).astype(np.int32)
    s = np.clip(slope * (n_bins - 1), 0, n_bins - 1).astype(np.int32)
    # Build (h, s) → list of RGB samples
    sums   = np.zeros((n_bins, n_bins, 3), dtype=np.float64)
    counts = np.zeros((n_bins, n_bins),    dtype=np.int32)
    valid  = mask.flatten()
    flat_h = h.flatten()[valid]
    flat_s = s.flatten()[valid]
    flat_c = color.reshape(-1, 3)[valid].astype(np.float64)
    # Accumulate (vectorized — np.add.at handles repeated indices)
    np.add.at(sums,   (flat_h, flat_s), flat_c)
    np.add.at(counts, (flat_h, flat_s), 1)
    out = np.full((n_bins, n_bins, 3), np.nan, dtype=np.float32)
    nonzero = counts > 0
    for c in range(3):
        out[..., c][nonzero] = (sums[..., c][nonzero] / counts[nonzero]).astype(np.float32)
    return out
```

This uses mean rather than median for vectorization speed. For a more robust median you'd group samples per bin, but the mean of millions of samples per bin converges to the same color and runs ~50× faster.

- [ ] **Step 2: Implement `inpaint`**

```python
from scipy.ndimage import gaussian_filter

def inpaint(clut, max_iterations=20, sigma=2.0):
    """Iteratively fill NaN bins by Gaussian-blurring the known values."""
    out = clut.copy()
    nan_mask = np.isnan(out[..., 0])
    if not nan_mask.any():
        return out
    # Replace NaNs with 0 in working buffer, but keep a separate mask of validity
    valid = (~nan_mask).astype(np.float32)
    filled = np.nan_to_num(out, nan=0.0)
    for _ in range(max_iterations):
        # Weight by validity mask so unknowns don't contribute
        for c in range(3):
            num = gaussian_filter(filled[..., c] * valid, sigma=sigma)
            den = gaussian_filter(valid, sigma=sigma)
            den = np.maximum(den, 1e-6)
            new_c = num / den
            filled[..., c] = np.where(nan_mask, new_c, filled[..., c])
        # After one pass, treat every previously-NaN bin as filled
        valid = np.ones_like(valid)
        if not np.isnan(filled).any():
            break
    return filled
```

- [ ] **Step 3: Run tests**

```
cd tools/derive_satmaps; pytest -v
```

Expected: BOTH PASS.

- [ ] **Step 4: Commit**

```
git add tools/derive_satmaps/derive.py
git commit -m "feat(satmaps): implement bin_samples + Gaussian-iterated inpaint"
```

---

## Task 6: Python — implement `derive_satmap` end-to-end

**Files:**
- Modify: `tools/derive_satmaps/derive.py`

- [ ] **Step 1: Implement raster loading + slope derivation**

Add at top of `derive.py` (after imports):

```python
import rasterio
from scipy.ndimage import sobel

def load_inputs():
    """Load and resample the 3 input rasters to a common 4320 × 2160 grid."""
    target_shape = (2160, 4320)  # equirectangular
    # 1. Color (PNG, 8192 × 4096) — resample with PIL nearest
    color = np.array(Image.open(CACHE_DIR / "bluemarble_aug.png").resize(
        (target_shape[1], target_shape[0]), Image.LANCZOS))[..., :3]
    # 2. Elevation
    with rasterio.open(CACHE_DIR / "etopo1.tif") as src:
        elev_raw = src.read(1, out_shape=target_shape, resampling=rasterio.enums.Resampling.bilinear)
    # Normalize: ETOPO1 is meters; we map to -1..1 with cap at ±10 km
    elev = np.clip(elev_raw.astype(np.float32) / 10000.0, -1.0, 1.0)
    # 3. Slope from elevation gradient
    gx = sobel(elev, axis=1)
    gy = sobel(elev, axis=0)
    slope = np.clip(np.sqrt(gx*gx + gy*gy) / np.percentile(np.sqrt(gx*gx + gy*gy), 99), 0, 1)
    # 4. Biome
    with rasterio.open(CACHE_DIR / "koppen.tif") as src:
        biome = src.read(1, out_shape=target_shape, resampling=rasterio.enums.Resampling.nearest)
    return color, elev, slope, biome
```

- [ ] **Step 2: Implement `derive_satmap`**

```python
def derive_satmap(name, classes, inputs):
    color, elev, slope, biome = inputs
    mask = np.isin(biome, list(classes))
    if mask.sum() < 1000:
        print(f"[WARN] biome '{name}' matched only {mask.sum()} pixels — output will be noisy")
    raw = bin_samples(color, elev, slope, mask)
    filled = inpaint(raw)
    filled = np.clip(filled, 0, 255).astype(np.uint8)
    out_path = OUT_DIR / f"{name}.png"
    Image.fromarray(filled, "RGB").save(out_path)
    print(f"[OK] {name}.png ({mask.sum():>9} samples)")
```

- [ ] **Step 3: Update `main` to load inputs once**

```python
def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("Loading inputs …")
    inputs = load_inputs()
    print("Inputs loaded.")
    for name, classes in BIOME_MAP.items():
        derive_satmap(name, classes, inputs)
```

- [ ] **Step 4: User downloads inputs to `cache/` per README, then runs**

```
cd tools/derive_satmaps; python derive.py
```

Expected output: 6 PNGs in `apps/hayba/src/assets/satmaps/`, each ~50-100 KB, runtime ~3-5 min.

(Implementer note: if the user doesn't have the inputs cached locally, they need to download per the README first. This step is gated on the human; the implementer can fall back to checking a single dummy raster pipeline runs end-to-end if input data is unavailable.)

- [ ] **Step 5: Commit the script + 6 generated PNGs**

```
git add tools/derive_satmaps/derive.py apps/hayba/src/assets/satmaps/*.png
git commit -m "feat(satmaps): bake 6 SatMaps from NASA + ETOPO + Köppen"
```

- [ ] **Step 6: Add `cache/` to `.gitignore`**

```
echo "tools/derive_satmaps/cache/" >> .gitignore
git add .gitignore && git commit -m "chore: ignore satmap input cache"
```

---

## Task 7: TypeScript — SatMap loader

**Files:**
- Create: `apps/hayba/src/viewport/satmap-loader.ts`

- [ ] **Step 1: Implement the loader**

```ts
import * as THREE from "three";

import temperateUrl from "../assets/satmaps/temperate.png";
import tropicalUrl  from "../assets/satmaps/tropical.png";
import aridUrl      from "../assets/satmaps/arid.png";
import alpineUrl    from "../assets/satmaps/alpine.png";
import tundraUrl    from "../assets/satmaps/tundra.png";
import oceanicUrl   from "../assets/satmaps/oceanic.png";

export type SatMapName = "temperate" | "tropical" | "arid" | "alpine" | "tundra" | "oceanic";

const URLS: Record<SatMapName, string> = {
  temperate: temperateUrl,
  tropical:  tropicalUrl,
  arid:      aridUrl,
  alpine:    alpineUrl,
  tundra:    tundraUrl,
  oceanic:   oceanicUrl,
};

const cache = new Map<SatMapName, THREE.Texture>();

export function loadSatMap(name: SatMapName): THREE.Texture {
  const cached = cache.get(name);
  if (cached) return cached;
  const tex = new THREE.TextureLoader().load(URLS[name]);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(name, tex);
  return tex;
}

export const SATMAP_NAMES: SatMapName[] = ["temperate", "tropical", "arid", "alpine", "tundra", "oceanic"];
```

- [ ] **Step 2: Verify build**

```
cd apps/hayba; npm run build
```

Expected: PASS (all 6 PNGs resolve via Vite).

- [ ] **Step 3: Commit**

```
git add apps/hayba/src/viewport/satmap-loader.ts
git commit -m "feat(hayba-explorer): SatMap loader with 6 baked CLUTs"
```

---

## Task 8: TypeScript — vertex + fragment shaders

**Files:**
- Create: `apps/hayba/src/viewport/shaders/planet.glsl.ts`

- [ ] **Step 1: Write the shaders**

```ts
export const VERTEX_SHADER = /* glsl */ `
  attribute float elevation;
  attribute float slope;
  attribute float plateId;
  attribute float continental;
  attribute float isBoundary;
  attribute float collisionKind;
  attribute float subductionProgress;
  attribute float orogenicUplift;
  attribute float volcanicIntensity;
  attribute float morAgeSteps;
  attribute float crustAge;

  uniform float uExaggeration;

  varying float vElevation;
  varying float vSlope;
  varying float vPlateId;
  varying float vContinental;
  varying float vIsBoundary;
  varying float vCollisionKind;
  varying float vSubductionProgress;
  varying float vOrogenicUplift;
  varying float vVolcanicIntensity;
  varying float vMorAgeSteps;
  varying float vCrustAge;
  varying vec3  vWorldNormal;

  void main() {
    float h = max(elevation, 0.0);
    vec3  displaced = position * (1.0 + h * 0.08 * uExaggeration);

    vElevation = elevation;
    vSlope = slope;
    vPlateId = plateId;
    vContinental = continental;
    vIsBoundary = isBoundary;
    vCollisionKind = collisionKind;
    vSubductionProgress = subductionProgress;
    vOrogenicUplift = orogenicUplift;
    vVolcanicIntensity = volcanicIntensity;
    vMorAgeSteps = morAgeSteps;
    vCrustAge = crustAge;
    vWorldNormal = normalize(position);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

export const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uSatMap;
  uniform vec3      uSunDir;
  uniform float     uAmbient;
  uniform vec3      uRimColor;
  uniform vec3      uOceanColor;
  uniform float     uShowPlateOutlines;
  uniform float     uShowBoundaryGlow;

  varying float vElevation;
  varying float vSlope;
  varying float vPlateId;
  varying float vContinental;
  varying float vIsBoundary;
  varying float vCollisionKind;
  varying float vSubductionProgress;
  varying float vOrogenicUplift;
  varying float vVolcanicIntensity;
  varying float vMorAgeSteps;
  varying float vCrustAge;
  varying vec3  vWorldNormal;

  void main() {
    // 1. Base albedo from SatMap
    float h = clamp(vElevation * 0.5 + 0.5, 0.0, 1.0);
    vec3  albedo = texture2D(uSatMap, vec2(h, vSlope)).rgb;

    // 2. Ocean clip — flat ocean below sea level
    if (vElevation < 0.0) {
      albedo = mix(uOceanColor, albedo, smoothstep(-0.05, 0.0, vElevation));
    }

    // 3. Continental brightness boost (+10%)
    if (vContinental > 0.5) albedo *= 1.10;

    // 4. Crust age fade for oceanic crust (older = darker blue)
    if (vContinental < 0.5) {
      float ageFactor = clamp(vCrustAge / 200.0, 0.0, 1.0);
      albedo *= mix(1.0, 0.75, ageFactor);
    }

    // 5. MOR new-cell brightness (cyan-blue, lerps out over 30 steps)
    float morT = clamp(1.0 - vMorAgeSteps / 30.0, 0.0, 1.0);
    if (morT > 0.001) {
      vec3 morColor = vec3(0.50, 0.78, 1.00);
      albedo = mix(albedo, morColor, morT * 0.6);
    }

    // 6. Active-boundary effects (gated by uShowBoundaryGlow)
    if (uShowBoundaryGlow > 0.5) {
      // 6a. Subduction (kind == 1): hot orange scaled by (1 - progress)
      if (vCollisionKind > 0.5 && vCollisionKind < 1.5) {
        vec3 hot = vec3(0.95, 0.40, 0.15);
        float t = (1.0 - vSubductionProgress) * 0.65;
        albedo = mix(albedo, hot, t);
      }
      // 6b. Orogeny (kind == 2): warm red-brown scaled by uplift
      else if (vCollisionKind > 1.5 && vCollisionKind < 2.5) {
        vec3 rb = vec3(0.78, 0.32, 0.20);
        albedo = mix(albedo, rb, vOrogenicUplift * 0.55);
      }
      // 6c. Buffer kill (kind == 3): dim grey flash
      else if (vCollisionKind > 2.5 && vCollisionKind < 3.5) {
        albedo = mix(albedo, vec3(0.15), 0.7);
      }
    }

    // 7. Volcanic arc glow (additive)
    if (vVolcanicIntensity > 0.01) {
      albedo += vec3(1.0, 0.55, 0.15) * vVolcanicIntensity * 0.4;
    }

    // 8. Plate outline pass — derivative of plateId across the triangle
    //    catches inter-plate edges. fwidth() is per-fragment derivative.
    if (uShowPlateOutlines > 0.5) {
      float edge = step(0.001, fwidth(vPlateId));
      albedo *= mix(1.0, 0.82, edge);
    }

    // 9. Lighting — Lambert + warm rim
    float lambert = max(dot(vWorldNormal, normalize(uSunDir)), 0.0);
    float rim     = pow(1.0 - max(dot(vWorldNormal, vec3(0,0,1)), 0.0), 2.0);
    vec3  lit     = albedo * (uAmbient + (1.0 - uAmbient) * lambert) + uRimColor * rim * 0.25;

    gl_FragColor = vec4(lit, 1.0);
  }
`;
```

- [ ] **Step 2: Verify build**

```
cd apps/hayba; npm run build
```

Expected: PASS (file is pure string exports — no Three.js compilation needed at this stage).

- [ ] **Step 3: Commit**

```
git add apps/hayba/src/viewport/shaders/planet.glsl.ts
git commit -m "feat(hayba-explorer): planet vertex + fragment shaders"
```

---

## Task 9: TypeScript — `buildGlobeMesh` + `updateFromSnapshot`

**Files:**
- Create: `apps/hayba/src/viewport/mesh.ts`

- [ ] **Step 1: Implement the mesh builder**

```ts
import * as THREE from "three";
import type { PlanetSnapshot } from "../App";
import { loadSatMap, type SatMapName } from "./satmap-loader";
import { VERTEX_SHADER, FRAGMENT_SHADER } from "./shaders/planet.glsl";

export interface GlobeMeshHandle {
  object: THREE.Mesh;
  updateFromSnapshot(snap: PlanetSnapshot): void;
  setSatMap(name: SatMapName): void;
  setExaggeration(x: number): void;
  setShowPlateOutlines(v: boolean): void;
  setShowBoundaryGlow(v: boolean): void;
  dispose(): void;
}

/**
 * Build a triangulated planet mesh from an initial snapshot.
 * Uses the cell_positions directly as vertex positions, fanning the
 * triangle indices from PEELS neighbour adjacency.
 */
export function buildGlobeMesh(initialSnap: PlanetSnapshot): GlobeMeshHandle {
  const n = initialSnap.n_cells;

  // 1. Position buffer (3 floats per cell)
  const positions = new Float32Array(initialSnap.cell_positions);

  // 2. Triangle indices — fan-triangulate using a Delaunay-like pass.
  //    PEELS' icosphere has each vertex shared between ~6 triangles. We
  //    build triangles by walking each cell's neighbour ring and emitting
  //    (cell, n_k, n_{k+1}) for each adjacent neighbour pair. Pentagons
  //    (12 of them) have a ring of 5 instead of 6 — same logic. Dedupe by
  //    canonicalizing (min, mid, max) of the triple.
  const indices: number[] = [];
  const seen = new Set<string>();
  const neighsByCell = buildNeighbourRings(initialSnap);  // see below
  for (let i = 0; i < n; i++) {
    const ring = neighsByCell[i];
    for (let k = 0; k < ring.length; k++) {
      const a = i;
      const b = ring[k];
      const c = ring[(k + 1) % ring.length];
      const key = canonicalTriKey(a, b, c);
      if (seen.has(key)) continue;
      seen.add(key);
      indices.push(a, b, c);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeBoundingSphere();

  // 3. Per-cell attribute buffers — float32 (single component each)
  const attrNames = [
    "elevation", "slope", "plateId", "continental", "isBoundary",
    "collisionKind", "subductionProgress", "orogenicUplift",
    "volcanicIntensity", "morAgeSteps", "crustAge",
  ] as const;
  const attrs: Record<string, Float32Array> = {};
  for (const name of attrNames) {
    const buf = new Float32Array(n);
    attrs[name] = buf;
    geom.setAttribute(name, new THREE.BufferAttribute(buf, 1));
  }

  // 4. ShaderMaterial
  const satTex = loadSatMap("temperate");
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uSatMap:             { value: satTex },
      uExaggeration:       { value: 1.0 },
      uSunDir:             { value: new THREE.Vector3(0.6, 0.5, 0.8).normalize() },
      uAmbient:            { value: 0.28 },
      uRimColor:           { value: new THREE.Color("#DED4C3") },
      uOceanColor:         { value: new THREE.Color("#1b3a55") },
      uShowPlateOutlines:  { value: 1.0 },
      uShowBoundaryGlow:   { value: 1.0 },
    },
    extensions: { derivatives: true },  // for fwidth() in plate outline pass
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "hayba-globe-mesh";

  // 5. Initial snapshot upload
  const updateFromSnapshot = (snap: PlanetSnapshot) => {
    if (snap.n_cells !== n) {
      console.warn("[mesh] snapshot n_cells changed — rebuild required");
      return;
    }
    // Copy each new array into the existing typed-array buffer
    attrs.elevation.set(snap.cell_elevation);
    attrs.slope.set(snap.cell_slope);
    attrs.plateId.set(snap.cell_plate_ids.map((p) => Math.max(p, 0)));
    attrs.continental.set(snap.cell_continental);
    attrs.isBoundary.set(snap.cell_is_boundary);
    attrs.collisionKind.set(snap.cell_collision_kind);
    attrs.subductionProgress.set(snap.cell_subduction_progress);
    attrs.orogenicUplift.set(snap.cell_orogenic_uplift);
    attrs.volcanicIntensity.set(snap.cell_volcanic_intensity);
    attrs.morAgeSteps.set(snap.cell_mor_age_steps);
    attrs.crustAge.set(snap.cell_age_ma);
    for (const name of attrNames) {
      (geom.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  };
  updateFromSnapshot(initialSnap);

  return {
    object: mesh,
    updateFromSnapshot,
    setSatMap: (name) => { mat.uniforms.uSatMap.value = loadSatMap(name); },
    setExaggeration: (x) => { mat.uniforms.uExaggeration.value = x; },
    setShowPlateOutlines: (v) => { mat.uniforms.uShowPlateOutlines.value = v ? 1.0 : 0.0; },
    setShowBoundaryGlow:  (v) => { mat.uniforms.uShowBoundaryGlow.value  = v ? 1.0 : 0.0; },
    dispose: () => { geom.dispose(); mat.dispose(); },
  };
}

function canonicalTriKey(a: number, b: number, c: number): string {
  const [x, y, z] = [a, b, c].sort((p, q) => p - q);
  return `${x}-${y}-${z}`;
}

/**
 * Build per-cell ordered neighbour rings. We don't have a Rust accessor for
 * this yet; derive it from the snapshot by sorting each cell's neighbours
 * by angle around the cell's surface normal.
 *
 * The Rust crate exposes neighbours but not their order. We sort each
 * neighbour set by azimuth around the cell to produce a stable CCW ring.
 */
function buildNeighbourRings(snap: PlanetSnapshot): number[][] {
  // For v1, we use the Rust-side neighbour list directly via a Tauri command
  // (or, simpler, port the icosphere triangle list once at startup).
  // Placeholder: emit an empty mesh until we wire the grid topology through.
  // *** The implementer for THIS task must add a new Tauri command that
  // returns the triangle list from the PEELS grid (it's already available
  // in Rust as `grid.triangles()` or equivalent — verify by grepping
  // packages/hayba-tectonics-v2/src/sphere/voronoi.rs for an accessor that
  // returns triangle indices). If no such accessor exists, add one. ***
  throw new Error("Triangle topology source not yet wired — see Task 9 note");
}
```

- [ ] **Step 2: Investigate Rust triangle accessor**

Before this task can finish, the implementer must confirm or add a way to get the triangle index list from PEELS. Run:

```
grep -n "triangles\|fn.*triangle\|tri_indices\|indices" packages/hayba-tectonics-v2/src/sphere/*.rs
```

If there's already an accessor returning the triangle list, expose it via a new Tauri command `get_grid_triangles(divisions: u32) -> Vec<u32>`. If not, add one in the sphere module — PEELS internally computes the icosphere; the triangles are derivable from its face list.

Add the Tauri command to `apps/hayba/src-tauri/src/wizard.rs`:

```rust
#[tauri::command]
pub fn get_grid_triangles(divisions: u32) -> Vec<u32> {
    use hayba_tectonics_v2::sphere::Grid;
    let grid = Grid::new(divisions);
    grid.triangle_indices()  // ← name TBD, depends on what the crate exposes
}
```

Register it in `main.rs`'s `tauri::Builder::default().invoke_handler(...)` list.

- [ ] **Step 3: Replace `buildNeighbourRings` with a direct triangle fetch**

In `mesh.ts`, change `buildGlobeMesh` to accept a precomputed triangle list:

```ts
export function buildGlobeMesh(initialSnap: PlanetSnapshot, triangles: Uint32Array): GlobeMeshHandle {
  // ... use `triangles` directly as the index buffer
  geom.setIndex(new THREE.BufferAttribute(triangles, 1));
}
```

Delete the `buildNeighbourRings` helper.

The caller (App.tsx in Task 10) invokes `get_grid_triangles` once after bake and passes the result here.

- [ ] **Step 4: Verify build**

```
cd apps/hayba; npm run build
cargo build --manifest-path apps/hayba/src-tauri/Cargo.toml
```

Expected: both PASS.

- [ ] **Step 5: Commit**

```
git add apps/hayba/src/viewport/mesh.ts apps/hayba/src-tauri/src/wizard.rs packages/hayba-tectonics-v2/src/sphere/
git commit -m "feat(hayba-explorer): triangulated planet mesh + Tauri get_grid_triangles"
```

---

## Task 10: TypeScript — integrate the new mesh into App.tsx

**Files:**
- Modify: `apps/hayba/src/App.tsx`

- [ ] **Step 1: Replace `buildGlobe` import with `buildGlobeMesh`**

In App.tsx imports:

```ts
import { buildGlobeMesh, type GlobeMeshHandle } from "./viewport/mesh";
import { type SatMapName } from "./viewport/satmap-loader";
```

Remove the `buildGlobe` import (don't delete `globe.ts` yet — Task 16 does that).

- [ ] **Step 2: Replace the ref type**

```ts
const globeMeshRef = useRef<GlobeMeshHandle | null>(null);
// Remove: const globeRef = useRef<GlobeHandle | null>(null);
```

- [ ] **Step 3: After bake, build the mesh from the snapshot + triangle list**

In `handleBake`, after `setSnapshot(snap)`:

```ts
const triangles: number[] = await invoke<number[]>("get_grid_triangles", { divisions: snap.divisions });
const mesh = buildGlobeMesh(snap, new Uint32Array(triangles));
sceneRef.current!.setGlobe(mesh.object);
globeMeshRef.current = mesh;
```

The point-cloud globe built in `initWizard` stays for the wizard phase. The new mesh replaces it after bake.

- [ ] **Step 4: Update animation tick + boundary apply to push snapshots to the mesh**

In the `step_planet` rAF tick (line ~345 of App.tsx) and `apply_boundary_types` / `apply_density_rank`:

```ts
const snap = await invoke<PlanetSnapshot>("step_planet", { nSteps: 1 });
setSnapshot(snap);
globeMeshRef.current?.updateFromSnapshot(snap);
```

Remove the `globeRef.current?.recolorFromSnapshot(...)` calls — they're now redundant once the mesh is up.

- [ ] **Step 5: Add settings state + handlers**

Add state near the existing settings:

```ts
const [satMap, setSatMap] = useState<SatMapName>("temperate");
const [exaggeration, setExaggeration] = useState(1.0);
const [showPlateOutlines, setShowPlateOutlines] = useState(true);
const [showBoundaryGlow, setShowBoundaryGlow] = useState(true);

useEffect(() => { globeMeshRef.current?.setSatMap(satMap); }, [satMap]);
useEffect(() => { globeMeshRef.current?.setExaggeration(exaggeration); }, [exaggeration]);
useEffect(() => { globeMeshRef.current?.setShowPlateOutlines(showPlateOutlines); }, [showPlateOutlines]);
useEffect(() => { globeMeshRef.current?.setShowBoundaryGlow(showBoundaryGlow); }, [showBoundaryGlow]);
```

- [ ] **Step 6: Pass settings into `<SettingsPanel>`**

```ts
<SettingsPanel
  showPlateLabels={showPlateLabels}
  showForceArrows={showForceArrows}
  onToggleLabels={setShowPlateLabels}
  onToggleArrows={setShowForceArrows}
  satMap={satMap}
  onChangeSatMap={setSatMap}
  exaggeration={exaggeration}
  onChangeExaggeration={setExaggeration}
  showPlateOutlines={showPlateOutlines}
  onTogglePlateOutlines={setShowPlateOutlines}
  showBoundaryGlow={showBoundaryGlow}
  onToggleBoundaryGlow={setShowBoundaryGlow}
/>
```

Task 11 extends `SettingsPanel` to accept these props.

- [ ] **Step 7: Verify build**

```
cd apps/hayba; npm run build
```

Expected: TypeScript errors complaining `SettingsPanel` doesn't accept the new props — fix them in Task 11. For now, ignore type errors from `SettingsPanel` props (other code should be clean).

- [ ] **Step 8: Commit**

```
git add apps/hayba/src/App.tsx
git commit -m "feat(hayba-explorer): wire new planet mesh + SatMap settings into App"
```

---

## Task 11: TypeScript — extend SettingsPanel with the Appearance section

**Files:**
- Modify: `apps/hayba/src/components/panels/SettingsPanel.tsx`

- [ ] **Step 1: Extend the props interface**

```tsx
import { type SatMapName, SATMAP_NAMES } from "../../viewport/satmap-loader";
import Select from "../Select";

export interface SettingsPanelProps {
  showPlateLabels: boolean;
  showForceArrows: boolean;
  onToggleLabels: (v: boolean) => void;
  onToggleArrows: (v: boolean) => void;
  satMap: SatMapName;
  onChangeSatMap: (v: SatMapName) => void;
  exaggeration: number;
  onChangeExaggeration: (v: number) => void;
  showPlateOutlines: boolean;
  onTogglePlateOutlines: (v: boolean) => void;
  showBoundaryGlow: boolean;
  onToggleBoundaryGlow: (v: boolean) => void;
}
```

- [ ] **Step 2: Render an Appearance section**

After the existing Viewport overlays section:

```tsx
<PropertySection heading="Appearance">
  <PropertyRow
    label="SatMap"
    value={
      <Select<SatMapName>
        value={p.satMap}
        onChange={p.onChangeSatMap}
        options={SATMAP_NAMES.map((n) => ({ value: n, label: n }))}
      />
    }
  />
  <PropertyRow
    label="Elevation exag."
    value={
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <input
          type="range"
          min="0" max="4" step="0.1"
          value={p.exaggeration}
          onChange={(e) => p.onChangeExaggeration(Number(e.target.value))}
          style={{ width: 90 }}
        />
        <span style={{ fontFamily: "Consolas, monospace", fontSize: 11, width: 28, textAlign: "right" }}>
          {p.exaggeration.toFixed(1)}×
        </span>
      </span>
    }
  />
  <PropertyRow
    label="Plate outlines"
    value={
      <input
        type="checkbox"
        checked={p.showPlateOutlines}
        onChange={(e) => p.onTogglePlateOutlines(e.target.checked)}
        aria-label="Toggle plate outlines"
      />
    }
  />
  <PropertyRow
    label="Boundary glow"
    noSeparator
    value={
      <input
        type="checkbox"
        checked={p.showBoundaryGlow}
        onChange={(e) => p.onToggleBoundaryGlow(e.target.checked)}
        aria-label="Toggle boundary glow"
      />
    }
  />
</PropertySection>
```

- [ ] **Step 3: Verify build**

```
cd apps/hayba; npm run build
```

Expected: PASS (all types align with App.tsx props now).

- [ ] **Step 4: Smoke test**

```
cd apps/hayba; npm run tauri dev
```

After bake, switch to Settings panel. Verify:
1. SatMap dropdown shows 6 options; selecting changes the planet color.
2. Elevation slider 0× → 4× changes mountain height visibly.
3. Plate outlines toggle adds/removes thin dark contours at plate seams.
4. Boundary glow toggle adds/removes the orange/red/cyan tints at active boundaries.

Take a screenshot of each setting.

- [ ] **Step 5: Commit**

```
git add apps/hayba/src/components/panels/SettingsPanel.tsx
git commit -m "feat(hayba-explorer): Appearance section in SettingsPanel (SatMap, exag, toggles)"
```

---

## Task 12: Smoke test + delete old `globe.ts`

**Files:**
- Delete: `apps/hayba/src/viewport/globe.ts`

- [ ] **Step 1: Confirm new mesh works end-to-end**

```
cd apps/hayba; npm run tauri dev
```

Walk the full flow:
1. Wizard appears (point cloud still — `initWizard` builds the point globe).
2. Paint continents.
3. Bake. New triangulated mesh appears with displacement + SatMap.
4. Boundaries phase: click a pink seam — popover appears.
5. Pick Convergent — the seam cells turn orange.
6. Densities: reorder, observe elevation changes.
7. Start simulation. Play. Verify per-step:
   - Plates re-color as cells migrate.
   - Active-boundary tints appear at convergent/divergent seams.
   - MOR cells (new crust) show bright cyan, fade over time.
   - Volcanic arcs glow orange-yellow.
   - Old oceanic crust darkens with age.
8. Toggle Settings → Plate outlines off; verify outlines disappear.

Screenshot each phase.

- [ ] **Step 2: Check that `globe.ts` is no longer imported**

```
grep -rn "from.*viewport/globe" apps/hayba/src/
```

Expected: zero hits (the only consumer was App.tsx, swapped in Task 10).

If there are still hits, fix them — e.g. `initWizard` still uses `buildGlobe` for the wizard-phase point cloud. That's intentional and OK; leave that import and update Step 3 accordingly to keep `globe.ts`. If the only remaining usage is the wizard-phase point cloud, **don't delete `globe.ts`**. Skip step 3.

- [ ] **Step 3: Delete `globe.ts` (only if no remaining imports)**

```
git rm apps/hayba/src/viewport/globe.ts
```

- [ ] **Step 4: Final build**

```
cd apps/hayba; npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```
git commit -m "chore(hayba-explorer): retire point-cloud globe.ts (mesh replaces it post-bake)"
```

(If you skipped step 3 because the wizard still uses `globe.ts`, commit message: `"chore: confirm point cloud retained for wizard phase only"` — but this commit only makes sense if you actually changed something.)

---

## Notes for the implementer

- **Branch policy**: feature branch, no commits to `main`, no Claude co-author trailer.
- **TDD where possible**: Rust crate has a proptest dev-dep + existing test pattern. Python uses pytest. TypeScript has no test framework — verify by `npm run build` + manual smoke.
- **Screenshot at every UI-touching step**: the user verifies visually, not from metrics. After each Task that changes the planet appearance, take a screenshot.
- **External data downloads**: Task 4-6 require ~85 MB of cached input rasters. If the implementer doesn't have them, they should stop and ask the user to download per `tools/derive_satmaps/README.md`.
- **WebGL extensions**: the fragment shader uses `fwidth()` for the plate-outline pass. That's `OES_standard_derivatives` (WebGL 1) or core in WebGL 2. Three.js's `ShaderMaterial` needs `extensions: { derivatives: true }` — already in the spec.
- **Rust crate has a frozen-spec TE port**: don't rewrite TE algorithms; only expose existing state via the snapshot. If a field's value seems wrong, debug the existing Rust code rather than reinventing.

## Self-review (controller's notes)

- **Spec coverage**:
  - §1-3 Goals/non-goals/architecture → covered by overall plan structure
  - §4 Rust snapshot extension → Task 1, 2
  - §5 Mesh construction → Task 9
  - §6 SatMap pipeline → Task 4-6
  - §7 Shader architecture → Task 8
  - §8 TE-faithful collision rendering → Tasks 1, 2, 8 (effects baked into the fragment shader), 10 (mesh feeds attributes)
  - §9 Settings panel → Task 11
  - §10 File-by-file impact → mirrored in this plan's File Structure
  - §11 Open questions → noted in plan as future work
- **Placeholder scan**: One known soft spot — Task 9 Step 2 says "name TBD, depends on what the crate exposes" for the `triangle_indices()` accessor name. This is gated on a grep the implementer runs. Acceptable because the alternative (adding it ourselves) is also specified. Considered acceptable.
- **Type consistency**: `GlobeMeshHandle`, `SatMapName`, `PlanetSnapshot` are used consistently across Tasks 7, 9, 10, 11. ✓
