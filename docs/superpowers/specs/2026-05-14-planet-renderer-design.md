# Hayba Explorer — Planet Renderer Design

**Date:** 2026-05-14
**Status:** Draft — awaiting user review
**Owner:** Badr
**Scope:** Replace the current point-cloud rendering in `apps/hayba` with a triangulated icosphere mesh shaded via Gaea-style 2D SatMaps. Adds vertex elevation displacement, TE-faithful active-boundary effects, and per-cell plate-motion visualization. Includes a one-time Python pipeline that bakes the SatMap CLUTs from real satellite + DEM data.

---

## 1. Goals

1. **Match Gaea's SatMap colorization.** Per-cell albedo is a `texture(satmap, vec2(height, slope))` lookup into a 2D CLUT. SatMaps are derived from NASA Blue Marble + ETOPO1 + Köppen-Geiger biome masks via a one-time Python bake.
2. **3D elevation displacement.** Vertex shader displaces each icosphere vertex outward by `elevation × exaggeration_slider`, defaulting to a subtle Earth-like factor with a Settings slider (0× to 4×).
3. **TE-faithful active-boundary effects** at convergent/divergent seams, with subducting cell fade-out and MOR new-cell fade-in.
4. **Plate motion visualization** — cells re-color per snapshot as the sim advances; combined with the active-boundary effects, this gives the breathing TE feel.
5. **Hayba lighting** — directional sun + ambient + warm beige rim glow, matching the chrome palette.

## 2. Non-goals

- Voronoi dual mesh (hex tiles). Triangle mesh per Q1 decision.
- Atmospheric volumetric scattering / sky / clouds / day-night terminator. Out of scope; covered by future work.
- Real-time PBR (Cook-Torrance). The Gemini research called this out as ideal; we are intentionally simpler — single albedo from SatMap, no separate roughness/metallic. Can revisit later.
- Ocean shader (waves, sun glint). Out of scope.
- Live SatMap import/painting in-app. We ship a fixed library of bake-derived SatMaps; user picks from a dropdown.

## 3. Architecture overview

```
                ┌─────────────────────────────────────────────────────┐
                │                  Rust sim (existing)                │
                │                                                     │
                │   model.step() ──► PlanetSnapshot (extended)        │
                │                       cell_positions                │
                │                       cell_plate_ids                │
                │                       cell_elevation                │
                │                       cell_continental              │
                │                       cell_is_boundary              │
                │                       cell_neighbor_plate           │
                │                       cell_slope        ← NEW       │
                │                       cell_latitude_band ← NEW      │
                └─────────────────────────────────────────────────────┘
                                       │
                                       ▼
                ┌─────────────────────────────────────────────────────┐
                │              TypeScript renderer (new)              │
                │                                                     │
                │   buildGlobeMesh(grid) ─► triangulated icosphere    │
                │      • static topology (triangles from PEELS)       │
                │      • per-vertex BufferAttributes:                 │
                │            position (3) — unit-sphere base point    │
                │            elevation (1)                            │
                │            slope     (1)                            │
                │            plateId   (1)                            │
                │            continental (1)                          │
                │            isBoundary (1)                           │
                │            boundaryType (1) — 0/1/2 = none/cnv/div  │
                │            boundaryActivity (1) — 0..1 decay        │
                │            cellAge   (1) — for MOR fade-in          │
                │            cellFading (1) — for subduction fade-out │
                │                                                     │
                │   updateFromSnapshot(snap)                          │
                │      • write the per-vertex attributes              │
                │      • diff vs previous snapshot to bump            │
                │        boundaryActivity, cellAge, cellFading        │
                │                                                     │
                │   Material: custom ShaderMaterial                   │
                │      • uniforms: satmap texture, exaggeration,      │
                │                  sunDir, ambient, rimColor,         │
                │                  oceanColor, time                   │
                │      • vertex:   pos = base * (1 + elev*exag)       │
                │      • fragment: sample satmap(elev, slope)         │
                │                  + boundary tint                    │
                │                  + Lambert + rim                    │
                └─────────────────────────────────────────────────────┘
```

## 4. Rust changes — Snapshot extension

`apps/hayba/src-tauri/src/planet.rs` adds two fields to `PlanetSnapshot`:

```rust
/// Magnitude of the elevation gradient at this cell, normalized to [0, 1].
/// Computed from neighbour-difference of `cell_elevation`.
pub cell_slope: Vec<f32>,

/// Latitude band index (0=equator, ..., 4=pole) derived from cell_position.
/// Used to gate SatMap blending when a SatMap is climate-zone-specific.
pub cell_latitude_band: Vec<u8>,
```

`snapshot_model()` populates these:
- `cell_slope[i]`: max |elev[i] - elev[neighbour]| over the cell's neighbours, normalized so 1.0 ≈ "cliff at planet scale."
- `cell_latitude_band[i]`: based on `|cell_positions[3i+1]|` (the y component is latitude on a Y-up sphere). Bands: tropical / subtropical / temperate / subpolar / polar.

Tests (`apps/hayba/src-tauri/src/planet.rs`): assert lengths equal `n_cells`, assert `cell_slope` is in [0, 1], assert latitude band of equatorial cell is 0, polar cell is 4.

## 5. Mesh construction

A new module `apps/hayba/src/viewport/mesh.ts` exposes:

```ts
export interface GlobeMeshHandle {
  object: THREE.Mesh;
  /** Update per-vertex attributes from a snapshot. */
  updateFromSnapshot(snap: PlanetSnapshot, opts?: {
    deltaTimeSec: number;        // for decay timers
    prevSnap?: PlanetSnapshot;    // for diff-based effects
  }): void;
  /** Switch the active SatMap. */
  setSatMap(name: SatMapName): void;
  setDisplacementExaggeration(x: number): void;
  dispose(): void;
}

export function buildGlobeMesh(grid: PeelsGrid): GlobeMeshHandle;
```

### Triangulation

PEELS gives us per-cell neighbours (6 for hex cells, 5 for the 12 pentagon cells). The triangle mesh is derived by:

1. For each cell `i`, compute its centroid `pos_i` (already in `cell_positions`).
2. Fan-triangulate each cell's neighbour ring around its centroid.
3. **Alternative (simpler, ships first):** use the **inverse dual** — render the icosphere triangles directly. PEELS stores cells at vertices of an icosphere; the underlying triangle mesh is the Delaunay of those points. We pull the triangle index list from PEELS' `triangles()` accessor (already exists in the Rust crate).

We go with the simpler alternative for v1: per-vertex shading on the icosphere triangle mesh. Each vertex is a cell. Triangles cover the sphere with no holes/overlaps.

### Per-vertex attribute layout

Each `BufferAttribute` is `Float32Array(n_cells)` (or `(n_cells × N)` for vec attributes). On snapshot update, we write the new values and set `needsUpdate = true`. The triangle index buffer is static (computed once at bake).

## 6. SatMap pipeline

A standalone Python tool `tools/derive_satmaps/derive.py` that runs once and outputs PNGs to `apps/hayba/src/assets/satmaps/`.

### Inputs (downloaded to `tools/derive_satmaps/cache/`)

| Layer | Source | Size | License |
|---|---|---|---|
| Color | NASA Blue Marble Next Generation (August, 8K equirectangular PNG) | ~30 MB | Public domain |
| Elevation + bathymetry | ETOPO1 (global GeoTIFF, 1 arc-min) | ~50 MB | Public domain |
| Biome classification | Köppen-Geiger raster (Beck et al. 2018, 1 km global) | ~5 MB | CC-BY |

### Pipeline

```
1. Load all three rasters, resample to a common 4320 × 2160 equirectangular grid.
2. For each pixel (x, y):
     h = normalize(elevation_raster[y, x])   // -1..1 with 0 = sea level
     s = normalize(slope_raster[y, x])       // 0..1
     c = color_raster[y, x]                  // RGB
     k = biome_raster[y, x]                  // one of 6 classes
     accumulator[k][bin_h, bin_s].append(c)
3. For each biome k:
     for each (h_bin, s_bin):
         clut_raw[h_bin, s_bin] = median(accumulator[k][bin_h, bin_s])
     clut_filled = inpaint(clut_raw)         // fill empty bins via Gaussian
     write 'apps/hayba/src/assets/satmaps/{k}.png' (256×256 RGB)
```

### Output presets (6 SatMaps shipped)

| Name | Biome filter | Use |
|------|--------------|-----|
| `temperate` | Köppen C* | Default for mid-latitude continents |
| `tropical` | Köppen A* + B (low-lat) | Equatorial regions |
| `arid` | Köppen B* (high-lat) | Deserts and dry highlands |
| `alpine` | Köppen ET (alpine tundra) | High-elevation peaks |
| `tundra` | Köppen ET (polar) + E | Polar plains, glacial coasts |
| `oceanic` | Köppen Cfb + B (coast) + waterbody dominant | Ocean-heavy planets |

Future: we can extend the library with user-contributed SatMaps. Library is a flat directory of `*.png` files; Hayba auto-discovers them on startup.

### Build hygiene

- The python tool lives in `tools/` not `apps/hayba/` to keep the JS build clean.
- The 6 output PNGs are **committed** to the repo. They are small (~80 KB each) and don't change unless we re-bake.
- The cached input rasters (~85 MB) are git-ignored. A `make satmaps` target re-runs the bake from cache.
- README in `tools/derive_satmaps/` documents the input URLs + a one-line invocation.

## 7. Shader architecture

`apps/hayba/src/viewport/shaders/planet.glsl.ts` exports two strings: `VERTEX_SHADER` and `FRAGMENT_SHADER`.

### Uniforms

| Uniform | Type | Source |
|---|---|---|
| `uSatMap` | `sampler2D` | Active SatMap from `apps/hayba/src/assets/satmaps/` |
| `uExaggeration` | `float` | Settings slider, default 1.0 |
| `uSunDir` | `vec3` | Static, normalized, looking at planet front-right-top |
| `uAmbient` | `float` | Constant ~0.25 |
| `uRimColor` | `vec3` | `colors.beige` warm rim glow on the dark side |
| `uOceanColor` | `vec3` | Slate, used to clip negative elevations into a flat-water look |
| `uTime` | `float` | Seconds since startup, for subtle animation if needed |

### Vertex shader

```glsl
attribute float elevation;        // -1..1, snapshot-driven
attribute float slope;            // 0..1
attribute float plateId;
attribute float continental;
attribute float isBoundary;
attribute float boundaryType;
attribute float boundaryActivity;
attribute float cellAge;
attribute float cellFading;

varying float vElevation;
varying float vSlope;
varying float vBoundaryActivity;
varying float vBoundaryType;
varying float vCellFading;
varying vec3  vWorldNormal;

void main() {
  // Displace outward along the surface normal (which on a sphere is just the position).
  float h = max(elevation, 0.0);  // ocean stays flat at the surface; only land lifts
  vec3 displaced = position * (1.0 + h * 0.08 * uExaggeration);

  vElevation = elevation;
  vSlope = slope;
  vBoundaryActivity = boundaryActivity;
  vBoundaryType = boundaryType;
  vCellFading = cellFading;
  vWorldNormal = normalize(position);  // unit-sphere normal — surface micro-bumps come from the SatMap, not from per-vertex normals

  gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
}
```

### Fragment shader

```glsl
uniform sampler2D uSatMap;
uniform vec3  uSunDir;
uniform float uAmbient;
uniform vec3  uRimColor;
uniform vec3  uOceanColor;

varying float vElevation;
varying float vSlope;
varying float vBoundaryActivity;
varying float vBoundaryType;
varying float vCellFading;
varying vec3  vWorldNormal;

void main() {
  // 1. Base albedo from SatMap (x = normalized elevation, y = slope)
  float h = clamp(vElevation * 0.5 + 0.5, 0.0, 1.0);
  vec2  uv = vec2(h, vSlope);
  vec3  albedo = texture2D(uSatMap, uv).rgb;

  // 2. Ocean clip — below sea level, override with flat ocean
  if (vElevation < 0.0) {
    albedo = mix(uOceanColor, albedo, smoothstep(-0.05, 0.0, vElevation));
  }

  // 3. Active-boundary tint
  if (vBoundaryActivity > 0.001) {
    vec3 convTint = vec3(0.85, 0.30, 0.15);  // hot orange
    vec3 divTint  = vec3(0.30, 0.55, 0.95);  // cool blue
    vec3 tint = (vBoundaryType > 1.5) ? divTint : convTint;
    albedo = mix(albedo, tint, vBoundaryActivity * 0.65);
  }

  // 4. Subducting fade-out
  albedo = mix(albedo, vec3(0.0), vCellFading * 0.5);

  // 5. Lighting — Lambert + rim
  float lambert = max(dot(vWorldNormal, normalize(uSunDir)), 0.0);
  float rim     = pow(1.0 - max(dot(vWorldNormal, vec3(0,0,1)), 0.0), 2.0);
  vec3  lit     = albedo * (uAmbient + (1.0 - uAmbient) * lambert) + uRimColor * rim * 0.25;

  gl_FragColor = vec4(lit, 1.0);
}
```

## 8. TE-faithful plate motion and collision rendering

This is the most important section. The Rust crate (`packages/hayba-tectonics-v2/`) is a line-by-line port of Tectonic Explorer's geophysics — it already does the heavy work. The renderer's job is to **surface that simulation state** in a way the user can read at a glance. Every visual effect here corresponds to a specific TE/Rust algorithm; the visual is not invented, it's a window onto state that already exists.

### 8.1 What the Rust sim already does each `model.step(dt)`

```
Phase A — Verlet integration (TE step 1)
  • For each plate, advance angular velocity ω by torque/dt using verlet.
  • Plate motion is rotation about an Euler pole; cells "owned" by the plate
    rotate with it.
  • Plate speeds are clamped at MAX_PLATE_SPEED.

Phase B — Field motion (TE step 2)
  • For each cell, its world position = plate.rotation * cell.local_pos.
  • The cell→grid-cell mapping is recomputed via nearest-neighbour lookup
    against the static icosphere grid (fields are advected through the grid,
    not the grid itself).

Phase C — Collision detection (TE detectCollisions)
  • Plates sorted by density (ascending).
  • For each plate's "possibly colliding" fields, look up which other plate
    owns the same icosphere cell.
  • Classify the overlap as one of FOUR kinds:
      - Subduction        (oceanic going under)
      - Orogeny           (continent-continent collision)
      - KillBottomOcean   (ocean caught between two continents)
      - DragOnly          (continent over ocean, no subduction)

Phase D — Per-cell geological processes
  • Subduction state advances (slab depth, dip, age, distance subducted).
  • Volcanic activity fires on cells above the subducting slab at the
    arc depth (70-100 km).
  • Orogeny thickens continental crust → uplifts elevation.
  • MOR (mid-ocean ridge) generates new fields at divergent boundaries with
    `crust.age = 0`, `elevation` matching ridge crest.
  • Subducting fields detach when progress saturates → field.alive = false.

Phase E — Plate housekeeping
  • Empty plates removed.
  • Plates grouped/split.
  • Plates divided by age.
  • Mantle plumes age, deposit hot-spot tracks.
```

All of this state is already in `Field`, `Plate`, `Subduction`, `VolcanicActivity`, `LithosphericColumn`. We just need to **expose** the relevant fields in the snapshot and **render** them.

### 8.2 Snapshot extension (full list)

`PlanetSnapshot` (Rust) gains these per-cell arrays. All are computed in `snapshot_model()` and serialized to the frontend per step:

| Field | Type | Meaning | TE/Rust source |
|---|---|---|---|
| `cell_slope` | `Vec<f32>` (0..1) | Local elevation gradient magnitude | derived from `cell_elevation` |
| `cell_latitude_band` | `Vec<u8>` (0..4) | Tropical / subtropical / temperate / subpolar / polar | derived from `cell_positions.y` |
| `cell_age_ma` | `Vec<f32>` | Crust age | `field.age` |
| `cell_crust_thickness_km` | `Vec<f32>` | Lithospheric thickness | `field.crust_thickness()` |
| `cell_volcanic_intensity` | `Vec<f32>` (0..1) | Volcanic activity level at this cell | `field.volcanic_activity` |
| `cell_collision_kind` | `Vec<u8>` | 0=none / 1=Subduction / 2=Orogeny / 3=Buffer / 4=Drag | `field.colliding` + collision record |
| `cell_subduction_progress` | `Vec<f32>` (0..1) | How far into subduction (used for fade-out) | `field.subduction.progress()` |
| `cell_is_continent_buffer` | `Vec<u8>` | Continent edge marker (TE coastline) | `field.is_continent_buffer` |
| `cell_orogenic_uplift` | `Vec<f32>` (0..1) | Active orogeny rate at this cell (recent uplift) | derived from `bending_progress` and crust thickening rate |
| `cell_mor_age_steps` | `Vec<u16>` | Steps since this cell spawned at MOR (0 = just spawned) | tracked in Rust between `generate_new_fields` calls |

The existing snapshot fields (`cell_positions`, `cell_plate_ids`, `cell_elevation`, `cell_continental`, `cell_is_boundary`, `cell_neighbor_plate`) stay.

Wire-format: keep `Vec<f32>`/`Vec<u8>`/`Vec<u16>` flat. Per-step transfer size at d=64 (~41K cells) with the additions is ~1.6 MB; gzip will trim heavily. Acceptable for rAF cadence.

### 8.3 Per-vertex GPU attributes

Each per-cell field above maps to a `BufferAttribute` on the mesh. They're all `Float32Array(n_cells)` (or normalized uint8 where it fits). The shader reads them as `attribute float ...`. On each `updateFromSnapshot()`, JS writes the new array into the buffer and sets `needsUpdate = true`.

```ts
// apps/hayba/src/viewport/mesh.ts attribute table
elevation          : Float32Array(n_cells)
slope              : Float32Array(n_cells)
plateId            : Float32Array(n_cells)   // for outline pass
continental        : Float32Array(n_cells)   // 0 / 1
isBoundary         : Float32Array(n_cells)   // 0 / 1
collisionKind      : Float32Array(n_cells)   // 0..4
subductionProgress : Float32Array(n_cells)   // 0..1
orogenicUplift     : Float32Array(n_cells)   // 0..1
volcanicIntensity  : Float32Array(n_cells)   // 0..1
morAgeSteps        : Float32Array(n_cells)   // 0..50, normalized in shader
crustAge           : Float32Array(n_cells)   // ma, normalized in shader
```

`plateId` flows in for an optional plate-outline pass: a fragment-shader epsilon-check on neighbour `plateId` differences draws a 1-pixel contour at plate seams (TE-faithful — TE draws plate outlines too).

### 8.4 Visual effects — one per TE algorithm

Each effect is implemented in the fragment shader using the attributes above. No JS-side decay timers (the spec previously proposed these — but TE's own state already gives us the time-evolving values we need).

| TE algorithm | Renderer effect | Shader uses |
|---|---|---|
| **Plate motion** (verlet, Phase A-B) | Cells re-color per snapshot as `plateId` changes. Optional plate-outline pass: 1-pixel dark contour at neighbour-plateId mismatches. Continental crust gets +10% albedo brightness vs oceanic to make continents stand out. | `plateId`, `continental` |
| **Convergent boundary — subduction** (`collisionKind == 1`) | The subducting cell gets a **hot orange tint** scaled by `(1 - subductionProgress)` — fresh subduction shows brightest; saturated subduction fades. The overriding top cell gets a +5% darken to suggest compression. | `collisionKind`, `subductionProgress` |
| **Convergent boundary — orogeny** (`collisionKind == 2`) | Continental-continental collision gets a **warm red-brown tint** modulated by `orogenicUplift`. Visually: as orogeny progresses, the cell rises (elevation already increases) and reddens. Mirrors TE's Himalaya-rise visual. | `collisionKind`, `orogenicUplift` |
| **Convergent boundary — continent buffer kill** (`collisionKind == 3`) | Cell briefly flashes a **dim grey** for the snapshot in which it dies, then disappears (becomes ocean / unowned). The flash is `mix(albedo, vec3(0.15), 0.8)`. | `collisionKind` |
| **Divergent boundary — MOR new crust** (`morAgeSteps`) | Newly spawned cells start **bright cyan-blue** (`#80c8ff` mixed in) and lerp to the SatMap color over ~30 steps as the cell ages. Mirrors TE's "young oceanic crust is hot/bright, old crust is dark." | `morAgeSteps`, `crustAge` |
| **Divergent boundary — pure pull-apart** (`isBoundary` & `collisionKind == 0` & continental==0 on both sides) | Cool **slate-blue rim** along the seam. Decays gradually as ridge ages (proxy via `crustAge`). | `isBoundary`, `collisionKind`, `continental` |
| **Volcanic arc** (`volcanicIntensity > 0`) | Active arc cells get a **glowing orange-yellow** additive: `albedo += vec3(1.0, 0.5, 0.1) * volcanicIntensity * 0.4`. Reads as molten activity. | `volcanicIntensity` |
| **Hot-spot tracks** (handled at Rust level via `plume_registry.record_tracks`) | The plume registry already deposits per-cell trail markers — the volcanic intensity attribute picks them up. Aging tracks fade per the registry's own decay. | `volcanicIntensity`, `crustAge` |
| **Crust age fade** (oceanic crust ages, gets denser, sinks slightly) | Older oceanic cells get a **subtle blue darken** proportional to `crustAge / 200ma`. Realistic-looking ocean basin gradient. | `crustAge`, `continental` |
| **Subducting cell death** (`field.alive = false` from `try_to_detach_from_plate`) | When a cell flips from one plate to another, if it was previously subducting (`subductionProgress > 0.95`), the new cell is drawn dim for one snapshot then settles into normal SatMap color. | `subductionProgress` (read on previous snapshot, diffed in JS-side tiny buffer) |

### 8.5 Vertex displacement — TE-faithful

The vertex shader pulls `elevation` outward along the cell normal. **Key detail:** TE does this displacement on the *visible* mesh while keeping the *raycast target* a perfect unit sphere (so brush/click hit-testing stays stable across elevation changes). We do the same — the `scene.raycastTarget` set in `scene.ts` stays a unit-radius `InvisibleSphere`; only the visible mesh displaces.

Displacement formula (matches TE's empirical scale):

```glsl
// Land: positive elevation pushes outward
float h = max(elevation, 0.0);
float r = 1.0 + h * 0.08 * uExaggeration;

// Ocean: stays flat at sea level (r = 1.0) for the visible mesh, BUT we still
// want to see trench depth in the SatMap (color), so elevation passes through
// as `vElevation` to the fragment shader unchanged.
vec3 displaced = position * r;
```

At `uExaggeration = 1.0`, the tallest mountains are ~8% of the planet radius — exaggerated vs Earth's ~0.1% but matches TE's tunable.

### 8.6 Plate motion latency budget

We re-upload all attributes on every snapshot. At 60 fps and d=64 (41K cells):
- Bytes per attribute: ~164 KB
- 11 attributes: ~1.8 MB/frame uploaded to GPU
- WebGL upload bandwidth: easily 200+ MB/s
- Frame budget: well within rAF

At d=128 (164K cells): ~7.2 MB/frame. Still fine. At d=256 (655K cells): ~28 MB/frame — tight but feasible. The wizard's resolution preset caps user-pickable d at 128 in v1, so we're not entering this zone.

### 8.7 What we deliberately do NOT visualize in v1

Per-cell state that exists in Rust but is **not** shown in the renderer (would be visual noise):

- `bending_progress` (slab bending angle) — used only to inform subduction's detach logic; not directly visible
- `dragging_plate` — only matters for force calculation, not shape
- `lithospheric_column` layers (sediment / basalt / granite stack) — too detailed for the planet view; reserved for a future "cross-section" tool
- `should_propagate_bending` — internal flag

These can be added later if/when a "geology inspector" panel needs them.

## 9. Settings panel additions

`apps/hayba/src/components/panels/SettingsPanel.tsx` gains a new section:

```
APPEARANCE
  SatMap          [ Temperate ▾ ]   (6 options)
  Elevation exag  [ slider ●────── ]  (0× ... 4×, default 1×)
  Plate outlines  [ checkbox ]        (default on)
  Boundary glow   [ checkbox ]        (default on; gates active-boundary effects)
```

State threads through to App.tsx → mesh handle:
- `setSatMap(name)` → swaps the uniform texture
- `setDisplacementExaggeration(x)` → updates the uniform
- toggles set boolean uniforms

## 10. File-by-file impact map

### New files

| Path | Responsibility |
|---|---|
| `tools/derive_satmaps/derive.py` | One-time Python bake script |
| `tools/derive_satmaps/README.md` | Pipeline doc |
| `apps/hayba/src/assets/satmaps/{temperate,tropical,arid,alpine,tundra,oceanic}.png` | The 6 baked SatMaps (256×256 RGB) |
| `apps/hayba/src/viewport/mesh.ts` | New triangulated planet mesh |
| `apps/hayba/src/viewport/shaders/planet.glsl.ts` | Vertex + fragment shader source |
| `apps/hayba/src/viewport/satmap-loader.ts` | Loads + caches SatMap textures |

### Modified files

| Path | What changes |
|---|---|
| `packages/hayba-tectonics-v2/src/model/model.rs` or sibling | Optional: helpers to expose per-cell slope/latitude if not already trivial |
| `apps/hayba/src-tauri/src/planet.rs` | Add `cell_slope` + `cell_latitude_band` to PlanetSnapshot; populate in `snapshot_model` |
| `apps/hayba/src/App.tsx` | Replace `buildGlobe` call with `buildGlobeMesh`; thread settings state to mesh handle |
| `apps/hayba/src/components/panels/SettingsPanel.tsx` | Add Appearance section |
| `apps/hayba/src/viewport/globe.ts` | Marked deprecated, replaced by mesh.ts. Deleted in a cleanup task at the end. |

## 11. Open questions / future work

- **Real PBR**: the Gemini research recommends Cook-Torrance + roughness/metallic + Fresnel. We ship without it; revisit when the SatMap-only look has been validated end-to-end.
- **Atmosphere + clouds**: not in this spec. Would need raymarching pass + cloud volumetrics. Tracked separately.
- **Ocean shader**: flat ocean color for v1. A later phase can add wave normals + Cox-Munk sun glint per the Gemini research.
- **Plate motion overlays**: existing plate-label sprites and force-arrow scaffolding (already on disk from the frontend-pass branch) integrate via the same scene graph; no changes needed.

---

## Appendix A — Decisions log

- **Q1 Mesh topology**: (A) triangle mesh (not Voronoi dual)
- **Q2 TE scope**: (B) core + active-boundary effects
- **Q3 Elevation**: (C) TE-faithful default + Settings slider 0×-4×
- **Q4 Palette/lighting**: superseded by user request for Gaea SatMaps — replaced with 2D CLUT pipeline + Hayba rim glow
- **SatMap sourcing**: (G3) derive from real Earth via Python bake — NASA Blue Marble + ETOPO1 + Köppen-Geiger
