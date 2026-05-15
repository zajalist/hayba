# Climate + Biome Texturing Engine — Design Spec

**Date:** 2026-05-15
**Status:** Approved (brainstorm complete; pending spec review)
**Supersedes:** the in-shader climate hacks in `planet.glsl.ts` (G.7 steps 2/6) and the iterative shader tuning of 2026-05-15

## Problem

Planet surface texturing has failed repeatedly through one root cause: colour was driven by smooth scalars (elevation → contour "bullseye" rings; or moisture → semantic scramble; or a 4-way SatMap average → grey mud), with a pure-zonal (latitude-only) pseudo-climate that produced no real rain shadow / continentality and visible artifacts (neon-orange patches, persistent grey north pole). The fix is an architectural redesign, not more tuning.

## Core principle

**Surface colour is a pure function of `(biomeId, organicNoise)`.** Every smooth field (elevation, latitude, continentality, currents) influences colour *only* by changing which **biome** a cell is classified as — never by directly indexing a colour ramp. Because nothing smooth-and-radial ever indexes a SatMap coordinate, contour rings are mathematically impossible. Biome boundaries are domain-warped (organic blobs, not iso-lines). The within-biome ramp is pure domain-warped noise (multi-shade, organic).

## Hard constraints (from grilling)

1. **Compute site:** Rust, inside `snapshot_model()`. Not in-shader, not a texture bake.
2. **Cadence:** recomputed **every sim step** (synced to moved cells over millions of years of tectonic sim).
3. **Budget:** therefore strictly **O(cells)** — multi-source BFS + bounded single-pass sweeps + analytic per-cell math only. No iterative relaxation. Target < ~3 ms/step at div=192 (~370k cells).
4. **Temporal model:** annual-mean only (no seasonal cycle) — keeps per-step cost low.
5. **Biome taxonomy:** Whittaker ~10.
6. **Precip rigor:** full worldbuildingpasta layers via O(cells) approximations.
7. **Elevation → colour:** only through climate → biome. Never a direct colour-ramp index.

## Architecture & data flow

```
Rust sim step → snapshot_model()
   ├─ climate::compute(grid, fields, seed) → ClimateFields   [EVERY step, O(cells)]
   │     per-cell: temperature_c, precip, biome_id
   │     (+ debug fields only when want_climate_debug)
   └─ PlanetSnapshot += cell_temperature[], cell_precip[], cell_biome[]
                        (+ debug arrays, gated)
        ↓ Tauri bridge (Float32Array per field)
   mesh.ts → 3 new BufferAttributes (biome id as float)
        ↓
   planet.glsl.ts → reads per-cell biomeId + climate; colours via
     per-biome SatMap sampled at a DOMAIN-WARPED ORGANIC NOISE coord;
     biome→biome blend = domain-warped near-discrete weights.
     ZERO climate math in shader (all precomputed).
```

### Module boundaries

- **`climate.rs`** — pure function `(grid, fields, seed) → ClimateFields`. No rendering. Independently unit-testable.
- **`PlanetSnapshot`** — widened additively (existing `#[serde(default)]` back-compat pattern). No change to bake/boundary/density flow.
- **`planet.glsl.ts` colour section** — reads `biome` + climate attrs only; no climate math.
- **Map-mode switch** — reads debug fields directly.

## The Rust climate engine (`climate.rs`)

Annual-mean. Pipeline order, all O(cells):

1. **Latitude & insolation.** `lat = asin(pos.y)`. Annual-mean insolation = smooth equator→pole falloff.
2. **Base temperature (°C).** `T = 30 − 50·sin²(lat) − 4.46·elevKm`, `elevKm = max(elev,0)·8` (4.46 °C/km lapse, worldbuildingpasta).
3. **Distance-to-ocean.** Multi-source BFS over the cell adjacency graph from all ocean cells simultaneously → hop-distance, scaled to km via mean cell spacing. O(cells). Cools interiors (annual proxy: winter-biased −) and feeds drying.
4. **Prevailing wind (per-cell tangent vector).** Bands (worldbuildingpasta): trades 0–30° E→W, westerlies 30–60° W→E, polar easterlies 60–90° E→W, slight meridional component.
5. **Ocean currents (analytic gyres).** Subtropical gyres → warm poleward western-boundary currents (up to +12 °C adjacent coasts) and cold equatorward eastern-boundary currents (up to −10 °C → coastal deserts: Atacama/Namib). Function of lat/lon/basin index + coastal proximity. O(cells). Adds ΔT to temperature; modulates coastal moisture.
6. **Precipitation (layered, O(cells)).**
   - *Zonal base:* ITCZ wet (0°, ±15°), subtropical dry (~30°), mid-lat wet (~55–60°), polar dry.
   - *Orographic:* elevation gradient projected on wind → windward wet / leeward rain shadow (relief >1 km significant, >2 km desert).
   - *Downwind moisture sweep:* sourced at onshore-wind coasts (boosted by warm currents), carried inland along wind, depleted by distance, blocked by relief >1 km. **Bounded** ordered sweep (fixed max hops) → O(cells).
   - *Continental drying:* from the distance-to-ocean BFS (onshore ~2500 km penetration, offshore ~1000 km).
   - Combine → `precip` (annual, normalized 0–1 with mm interpretation for thresholds).
7. **Biome classification — Whittaker ~10.** `(annualTemp, annualPrecip)` lookup → `biome_id`. Lookup coords get a small domain-warped noise offset (sampled at the cell's *current world position*, seeded) so boundaries are organic and evolve correctly as continents drift.
8. **Debug fields** captured only when `want_climate_debug`: insolation, base temp, dist-to-ocean (km), wind vec, current ΔT, orographic term, downwind moisture, continental dryness, final temp, final precip, biome id.

**Determinism:** pure function of `(grid, fields)` + planet seed (boundary noise). No frame state.

**Unit tests:** synthetic continent + prevailing wind ⇒ assert leeward cells drier than windward; deep-interior driest; equatorial lowland wet; poles classified ice; a tall equatorial peak classified alpine/cold not rainforest.

## Texturing masks

Two layers. Each SatMap sampled as an organic-noise-indexed ramp (multi-shade, never flat).

### Layer A — Biome masks (climate-driven, pick the base SatMap)

| # | Biome | Condition | SatMap | Hue |
|---|---|---|---|---|
| 1 | Tropical rainforest | hot, very wet | `tropical_wet_basin` | deep green |
| 2 | Tropical savanna/seasonal | hot, moderate | `tropical_dry_craton` | yellow-green/tan |
| 3 | Hot desert | hot, dry | `arid_hot_dunes` | muted tan-ochre |
| 4 | Temperate rainforest | mild, very wet | `temperate_humid_coast` | rich green |
| 5 | Temperate forest | mild, wet | `temperate_humid_orogeny` | mid green |
| 6 | Woodland/shrubland (Med) | mild, semi-dry | `temperate_med` | olive/sage |
| 7 | Grassland/cold steppe | cool, dry | `continental_steppe` | straw/pale green |
| 8 | Boreal/taiga | cold, moderate | `continental_shield` | dark blue-green |
| 9 | Tundra | very cold | `polar_tundra` | mottled brown-grey-green |
| 10 | Ice/polar | frozen | `polar_icecap` | near-white |

5 distinct greens (1,4,5,8 + savanna-yellow-green 2 / steppe 7). SatMap slots wired in `mesh.ts` via the existing `pick()` fallback helper.

### Layer B — Modifier masks (layered on top)

| Mask | Driven by | SatMap/colour | Effect |
|---|---|---|---|
| Rock/exposed | slope (steep, any biome) | `*_orogeny` family | bedrock on cliffs/mountain faces |
| Snow overlay | annual temp < freezing AND not ice biome | near-white | equatorial mountain snowcaps, alpine line |
| Coast/beach | thin sea-level band | muted sand | shoreline |
| Ocean | below sea level | procedural Beer-Lambert (already correct) | dark navy depth gradient (not a SatMap) |

### Composite order

`base = SatMap[argmax biome]` with thin **domain-warped** crossfade to 2nd-place biome → `mix → rock` (slope) → `mix → snow` (snow mask) → `mix → beach` (coast) → ocean replaces below sea level. Each SatMap sampled at the organic-noise ramp coord. Lighting = the existing flat-lit soft-wrap term (kept; user-validated). Colour pipeline (sRGB decode on sample / linear / sRGB encode, no ACES) kept.

## Grey-pole fix

The pole is now biome #10 (discrete per-cell ice classification) — the whole cap is unambiguously the ice slot, no blend bleed-through. Ice biome's ramp index uses very low noise amplitude + low-contrast clamp → near-white with a faint low-frequency cool-blue shade (matches the real-Earth reference). Bare-rock fringe falls out free from the Layer-B slope mask on steep coastal cells (real Greenland look). Snow overlay reinforces and also caps equatorial peaks.

## Map modes (validation)

Settings ▸ Diagnostics dropdown, every climate stage inspectable: elevation · slope · insolation · base-temp · distance-to-ocean · prevailing-wind · ocean-current ΔT · orographic · downwind-moisture · continental-dryness · final temperature · final precipitation · **biome (argmax, flat colour per biome — key validation)**. ~13 modes. Each reads a per-cell debug field. `uMapMode` uniform extended; `setMapMode` already wired.

## Data contract changes

- **Always shipped** (`PlanetSnapshot`): `cell_temperature: Vec<f32>`, `cell_precip: Vec<f32>`, `cell_biome: Vec<f32>` (id stored as float for the buffer attribute). Proportional to the 11 arrays already shipped per step (~4 MB at div=192, same order as today).
- **Debug arrays** (insolation, dist-to-ocean, wind, current ΔT, orographic, downwind, continental-dry) shipped only when `want_climate_debug` is set on the step/snapshot Tauri call (set when a non-zero map mode is active). Keeps the hot path lean.
- `mesh.ts`: 3 new `BufferAttribute`s; `updateFromSnapshot` writes them; biome id as float.
- Shader: read `biome`/`temperature`/`precip` varyings; delete all in-shader climate math (the worldbuildingpasta block added earlier).

## Out of scope (separate follow-on spec)

Client-facing **post-bake texture editor** — a new post-bake panel category for per-biome SatMap reassignment from the 25-map library + texturing params. Depends on these biome slots existing; gets its own spec/plan after this lands.

## Success criteria

1. **No contour rings** at any elevation/zoom (bullseye permanently dead).
2. **≥5 visually distinct greens** across biomes; no neon-orange artifacts.
3. **Visible non-zonal climate**: rain shadows leeward of ranges, dry continental interiors, current-driven coastal deserts — confirmable in the precip/biome map modes.
4. **Smooth near-white poles** with rocky fringe; no grey mottle.
5. Biome map mode reads like an Earth biome map (green equatorial belt, ~30° desert belts, mid-lat forests, white poles).
6. Climate recomputes every sim step synced to drifting continents, < ~3 ms/step at div=192.
7. `climate.rs` unit tests pass (rain-shadow / interior-dry / pole-ice / equatorial-peak-cold assertions).
