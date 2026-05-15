# Climate + Texturing Model — QA Critique & Tuning-UX Design

**Date:** 2026-05-15
**Author:** self-critique pass (no implementation; analysis + design only)
**Scope:** `apps/hayba-explorer/src-tauri/src/climate.rs`, `apps/hayba-explorer/src/viewport/shaders/planet.glsl.ts`, `mesh.ts`, the Texturing/map-mode UI.

---

## Part A — QA critique (flaws found)

Severity: **S1** breaks correctness/believability · **S2** materially wrong but tolerable short-term · **S3** polish.

### A1. (S1) Spec-vs-implementation gap: the downwind moisture sweep was never built

The design spec and plan (`2026-05-15-climate-biome-engine` §6 / Task 8) promised a **bounded downwind moisture sweep** — moisture sourced at onshore coasts, carried inland along the wind, depleted by distance, blocked by relief. The shipped `compute_climate` does **only** zonal bands + a *single-ring local* orographic term + a continental-distance dryness + noise. There is **no moisture transport**. Consequence: rain shadows are local one-cell artifacts, not the hundreds-of-km lee deserts the user explicitly asked for (Atacama/Gobi behaviour). This is the single biggest scientific shortfall and the exact effect the user keeps asking to see. The "orographic" map mode will look like thin noise on ridgelines, not real rain shadows.

### A2. (S1) Two sources of truth for biomes → map mode disagrees with render

`climate.rs::classify_biome` uses **hard** thresholds (temp < −15 ice, < −2 tundra, < 6 boreal, < 18 temperate split by precip, else hot). The shader re-derives **soft** weights with *different* smoothstep edges (`smoothstep(6,8)`, `smoothstep(16,18)`, precip `smoothstep(0.62,0.72)`…) **plus** per-fragment `±4 °C / ±0.18` noise on `warpT/warpP`. The categorical `cell_biome` (Biome map mode) and the actually-rendered colour are computed by two independent threshold sets → the Biome debug map does **not** faithfully show what the planet renders. Validating "the masks" is therefore unreliable by construction.

### A3. (S1) Within-biome elevation removed from colour → flat shading + texture crawl

`h` (the SatMap ramp coordinate) is now **pure organic FBM** (`fbm*0.6 + fbm*0.4`); elevation contributes nothing. Two problems:
- A lowland plain and a 6 km plateau in the same biome get the same colour distribution — no valley→upland tonal banding. Real satellite terrain has strong within-biome elevation tone.
- The FBM is keyed on `vWorldNormal` (**world space**). As plates drift over a million-year sim, the crust slides *through* a space-locked noise field → the surface texture **crawls/shimmers** under moving continents. Colour detail must be attached to the *cell/crust*, not to world position.

### A4. (S1) Ocean currents are geographically fictional

`current_temp_anomaly` keys warm/cold on `fract(lon / (2π/3))` — it assumes exactly **3 ocean basins at fixed longitudes**, independent of where continents/oceans actually are. On a procedurally drifting planet the "western boundary current" lands on arbitrary coasts unrelated to real ocean shape. It will produce plausible-looking but **geographically nonsensical** coastal warming/cooling, and it shifts every step as longitude wraps. Currents must derive from the actual land/ocean mask (e.g. gyre centres = ocean-basin centroids from the BFS), not fixed longitude bins.

### A5. (S2) Temperature model uncalibrated to the sim's hypsometry

`base_temperature_c = 30 − 50·sin²φ − 4.46·(elev·8)` hardcodes "vElevation 1.0 = 8 km". `vElevation` is sim-normalised with an **unknown, drifting distribution** (it changes as orogeny runs). Nothing calibrates the 8 km scale to the sim's actual elevation histogram, so the lapse term is either negligible (if the sim rarely exceeds 0.3) or freezes everything (if it clusters high). The "all-white temperature" screenshot is consistent with this: the sin² curve keeps 0–25° latitude at ~25–30 °C and the lapse term barely fires. `sin²φ` also makes the tropics too flat and the temperate gradient too compressed vs Earth's roughly-linear-in-|φ| annual mean.

### A6. (S2) Continentality is a non-physical fudge

`coastalness = hops / max_hop` normalises every cell's inland distance by the **single largest** distance on the whole globe — so identical physical inland distance yields different continentality on a one-supercontinent world vs an archipelago, and `max_hop` jumps discontinuously as continents merge/split during the sim (climate will visibly "breathe" between steps). And the effect is a uniform `−6 °C` annual cooling, whereas real continentality is about *seasonal range*, which the annual-mean model structurally cannot represent. Distance should be scaled by an absolute km figure (via `field_area_km2`), not globe-relative.

### A7. (S2) Unprincipled precipitation mixing

`pr = clamp(zonal·cont + orographic·0.5 + (noise−0.5)·0.25, 0, 1)`. The coefficients have no physical basis; `orographic ∈ [−1,1]` added to a `[0,1]` base then clamped means orographic either saturates or is clipped, and a dry zonal band can't be made wet by a windward coast (multiplicative `zonal·cont` caps it). Layer composition should be physically ordered (base humidity → transport → orographic enhancement/shadow → continental depletion), not a flat weighted sum.

### A8. (S3) "Insolation" is mislabeled

The `insolation` debug field is `1 − p.y²` (≈ cos²φ). Real annual-mean top-of-atmosphere insolation is a flatter curve (~2.4:1 equator:pole, not 1:0). Harmless as a relative shade but it is **not insolation** and shouldn't be presented as a validated physical field.

### A9. (S3) Layer compositing order is ad hoc

Final colour = biome-weighted SatMap → rock(slope) mix → ice(temp) mix → beach(arid) mix, each with hand-tuned constants, applied in an order nobody chose deliberately. Ice is a *post-mix overlay*, not biome #9, so (like A2) the Biome map mode won't show ice where the override paints it. Rock/ice/beach interact (rock under ice under beach) producing the muddy seams seen earlier.

### A10. (S3) Discarding 255/256 SatMap columns; no atmosphere

`sampleGradient` always reads `uv.x = 0.5`. If SatMaps carry any horizontal authored variation it's thrown away. Separately, atmosphere/scattering was cut from scope — the limb has no air glow, which reads as "not a planet" regardless of surface quality.

**Headline takeaways:** the four S1 flaws (A1 missing transport, A2 dual biome truth, A3 flat+crawling colour, A4 fictional currents) are why the masks "look fake" and don't agree with the render. They are *model/architecture* faults, not constant-tuning — no slider fixes them. They should be corrected before exposing tuning, or the user will be tuning a broken basis.

---

## Part B — Tuning UX design

**Principle:** the user tunes; we expose the model's parameters as live controls, *paired with the relevant map mode* so every tweak is immediately validated against its own mask (the Gaea workflow: adjust a curve, watch the field).

### B1. Make the climate model parameter-driven (architecture prerequisite)

Today the climate constants are hardcoded in `climate.rs` (`T_EQUATOR`, `T_LAT_DROP`, `LAPSE_C_PER_KM`, `ELEV_KM_SCALE`, the 6 °C continentality, current strength, ITCZ widths, precip weights, biome thresholds). For the user to tune them live they must become a **`ClimateParams` struct** with `#[serde(default)]` defaults, threaded `App → Tauri (step_planet/bake_from_wizard) → snapshot_model → compute_climate`. Changing a slider sets the params and triggers one re-snapshot (O(cells), already every-step-cheap). Texturing/shader params (noise scale, biome sharpness, ice line, rock slope, beach aridity, lighting) are **uniforms** — instant, no Rust round-trip.

### B2. Single source of truth for biomes (fixes A2 as a side effect)

Move the biome thresholds into `ClimateParams` and have the shader read the *same* values via uniforms (or render from `cell_biome` directly with a thin AA crossfade derived from a per-cell second-best biome shipped by Rust). Either way: one threshold set. The tuning UI then edits *that* set and the Biome map mode is guaranteed faithful.

### B3. Panel structure — "Climate Lab" (new post-bake category, or a section in Texturing)

Grouped, collapsible sections; each parameter is a labelled slider with live numeric value, a reset arrow, and a "📊" button that switches the on-canvas Map mode to the field that parameter most affects:

| Group | Params | Pairs with map mode |
|---|---|---|
| **Temperature** | equatorial °C, equator→pole drop, latitude curve (sin² ↔ linear blend), lapse °C/km, elevation→km scale (with an auto-calibrate button: fit to the sim's current elevation P5–P95) | Temperature |
| **Moisture** | ITCZ width, subtropical-dry depth, mid-lat-wet strength, base humidity, noise amount | Precipitation |
| **Orographic / transport** | wind-band latitudes, moisture-plume reach (km), relief-block height, lee-shadow strength | Orographic |
| **Continentality** | inland cooling °C/1000 km, inland drying /1000 km (absolute-km scaled, fixes A6) | Continental dryness / Distance-to-ocean |
| **Currents** | warm/cold anomaly °C, coastal reach (after A4 fix: gyre count auto-derived) | Ocean current ΔT |
| **Biome thresholds** | the Whittaker cut temps & precips (one source, B2) — ideally a 2-D Whittaker editor (drag region boundaries on a temp×precip chart) | Biome |
| **Texturing** | per-biome SatMap + min/max/bias (done), within-biome elevation weight (fixes A3), biome-edge sharpness, ice-line temp, rock slope threshold, beach aridity, light wrap | (final render) |

### B4. Workflow affordances (Gaea-grade)

- **Auto-pair**: focusing a parameter group auto-switches the canvas Map mode to its diagnostic field; leaving returns to Final. This is the core "see what you tune" loop.
- **Presets**: Earth-like (defaults), Arid world, Ice world, Ocean world, Hothouse — one click sets the whole `ClimateParams`. Essential because 25+ knobs is overwhelming; presets give a sane start, sliders refine.
- **Reset-to-default** per slider and per group.
- **2-D Whittaker biome editor** instead of raw threshold sliders: a temp(x)×precip(y) chart with draggable region cells coloured by the biome's SatMap; this is the single highest-leverage UX — it makes the abstract thresholds tangible and self-documenting, and directly drives both render and Biome map mode (after B2).
- **Live histogram overlays**: on the elevation→km slider show the sim's actual elevation histogram so the user calibrates against real data (directly addresses A5); on temperature/precip sliders show the resulting value distribution.
- **Determinism note**: tuning params is fine to apply live during a paused sim; while playing, apply on the next step (params are inputs to the every-step `compute_climate`).

### B5. Recommended sequencing

1. **Fix the S1 model flaws first** (A1 transport, A2 single biome truth, A3 cell-stable + elevation-weighted colour, A4 geography-derived currents). Tuning a broken basis wastes the user's time.
2. Introduce `ClimateParams` plumbing (B1) with current values as defaults — zero behaviour change, pure enablement.
3. Ship the Climate Lab panel with sliders + presets + auto-pair (B3/B4).
4. Add the 2-D Whittaker editor + histogram overlays (highest-value, do after the basics work).

The texturing per-biome SatMap + min/max/bias picker (already shipped) is the template for the slider/preview interaction; extend that pattern to the climate params.

---

## One-paragraph executive summary

The visible-quality problems are **not** mis-tuned constants — they are four structural faults: (1) the promised downwind moisture transport was never implemented so rain shadows are fake; (2) Rust and the shader classify biomes with two different threshold sets so the Biome map mode lies about the render; (3) within-biome colour dropped elevation entirely and is keyed to world space so it both looks flat and crawls under drifting continents; (4) ocean currents are bound to fixed longitudes instead of real ocean geometry. Fix those before exposing tuning. For tuning UX: make the climate constants a serde-defaulted `ClimateParams` threaded into the every-step `compute_climate`, expose them as grouped sliders + world presets in a "Climate Lab" panel, and — the highest-leverage piece — replace raw biome-threshold sliders with a draggable 2-D Whittaker (temperature × precipitation) editor, with each parameter group auto-switching the on-canvas Map mode to its own diagnostic mask so every adjustment is validated as it's made.
