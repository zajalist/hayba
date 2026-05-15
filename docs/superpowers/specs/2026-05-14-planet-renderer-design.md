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

## 8. Active-boundary effects (state in TS, not Rust)

The Rust sim already advances plates and reports cell→plate assignments per snapshot. The renderer derives the visual effects by **diffing snapshots**:

| Effect | State per cell | Update rule |
|---|---|---|
| Convergent/divergent "compression" pulse | `boundaryActivity: float` (0..1) | When a cell becomes `is_boundary` and its pair has an assigned type, bump `boundaryActivity = 1.0`. Decay 10%/sec. |
| MOR new-cell brightness | `cellAge: float` (0..1+) | When a cell flips from "no plate" or a different plate id to its current one near a divergent boundary, set `cellAge = 0`. Increment by `deltaTimeSec / 5.0`. SatMap lookup uses `mix(brightFactor, 1.0, clamp(cellAge, 0, 1))`. |
| Subducting fade-out | `cellFading: float` (0..1) | When a cell is adjacent to a convergent boundary AND on the denser plate (looking up density rank), drift cellFading toward 1.0 over ~3 sec. When the sim reassigns it, snap cellFading back to 0. |

All three states are `Float32Array(n_cells)` maintained in `globe.ts`. The diff happens on each `updateFromSnapshot` call.

## 9. Plate motion visualization

This works "for free" once the new renderer is in place:

- Rust's `model.step()` reassigns cell plate ids each step.
- `updateFromSnapshot()` writes the new `plateId` attribute into the BufferAttribute.
- The fragment shader doesn't directly use `plateId` for color (the SatMap drives albedo), but `boundaryActivity` pulses any cell that *just changed* plates, which is exactly the visual of plate drift.

If we want stronger plate-boundary visibility (currently subtle because the SatMap doesn't tint by plate id), an optional **plate outline pass** can run in fragment: when `isBoundary > 0.5`, darken the albedo by 15%. This gives a TE-like thin contour on every active seam.

## 10. Settings panel additions

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

## 11. File-by-file impact map

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

## 12. Open questions / future work

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
