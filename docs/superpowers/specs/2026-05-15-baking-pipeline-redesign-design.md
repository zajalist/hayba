# Baking Pipeline Redesign — Umbrella Architecture Spec

**Date:** 2026-05-15
**Status:** Approved (brainstorm complete, research-validated). Umbrella spec — drives
per-subsystem specs (A–D) and their implementation plans.
**Supersedes:** Plan-A coarse-graph macro hydrology
(`docs/superpowers/plans/2026-05-15-coarse-graph-macro-hydrology.md`), the per-cell
Goldberg bake erosion in `hydrology.rs`/`wizard.rs`, and the per-cell mask attribute
packing in the current shader path.

**Goal:** Replace the entire post-paint "bake" with a GPU pipeline that takes the
painted macro sphere, carves geomorphologically real high-frequency detail into it
without destroying the macro relief, recomputes every climate/terrain mask from the
detailed result, and shades it with a live, always-on multi-layer SatMap system.

**Research basis:** `docs/research/2026-05-15-erosion-on-real-dem-gemini-prompt.md`
(+ Gemini response), the GitHub erosion-implementations report, and the
pipeline-validation report (LanLou123/Webgl-Erosion, H-Schott/MultiScaleErosion
SIGGRAPH 2024, Frozen Fractal "Around The World", World Machine Frequency Splitter,
Gaea SatMap/Combine docs, dandrino/terrain-erosion-3-ways, GameDev.net planet-scale
erosion, Jákó CESCG 2011).

---

## 1. Why scratch the old pipeline

The old bake (Plan A) ran an uplift-driven stream-power LEM on the ~10k–600k-cell
Goldberg graph. It is the wrong algorithm class (relaxes to an input-independent
steady state → erased the painted/Earth DEM, the "distance-into-continent" artefact)
*and* the wrong resolution (the graph is far too coarse for thin coastlines and
dendritic rivers). The redesign changes both: a **carving** algorithm (no uplift
attractor) on a **high-resolution raster**, with all masks recomputed from the
result.

## 2. Three planes

1. **Authoring plane (unchanged):** the existing Goldberg geodesic sphere. The user
   paints continents / elevation / biome intent on cells. This is the *macro input
   only* and is not modified by this spec.
2. **Bake plane (new, GPU, offline "bake-then-watch"):** rasterize the painted sphere
   → carve detail via multi-scale amplification erosion → recompute all masks. Erosion
   is **solved on an equal-area cube-sphere** and **resampled to an equirectangular
   texture** for storage/masks/shading.
3. **Render/shade plane (new, GPU, live, always-on):** a multi-layer SatMap composite
   shades the equirect every frame, driven by an always-accessible Shading Settings
   panel. No discrete "texturing" step.

## 3. Canonical pipeline (normative)

```
P1 Macro     rasterize painted Goldberg sphere → h0  (cube-sphere, RGBA32F)
P2 Proxy     low-res prevailing-wind orographic raymarch + macro slope over h0 → C_proxy
P3 Erosion   multi-scale amplification on the cube-sphere (inputs h0, C_proxy):
               pyramid coarse→fine, per level:
                 inject deterministic seam-continuous fBm/ridged detail band
                 erode  → thermal(talus-clamped) → deposition
                 upsample ×2 (carry height + water + sediment)
               macro preservation: h_final = h_eroded + β·(h0 − lowpass(h_eroded))
P4 Resample  cube-sphere h_final → equirect h_final (8K, RGBA32F)
P5 Mask bake compute the full mask library ONCE from equirect h_final (MRT groups);
               bake the ~5–6px edge-aware micro-bleed into boundary masks here
P6 Shade     live single-tap multi-layer SatMap composite from masks + UI state
```

`U=0` (no uplift) everywhere. Per-step incision is hard-clamped (`ε`). The erosion
solve grid is the cube-sphere (§5.1); everything downstream of P4 is equirect.

## 4. Global contracts

- **Solve grid:** equal-area **cube-sphere** (6 square faces projected to the sphere;
  QSC-style equal-area mapping). No pole singularity, no ±180° seam, near-uniform
  cell area — the prerequisite for correct drainage (validated: Frozen Fractal,
  GameDev planet-scale erosion, `nixis` all rejected raw equirect for the solve).
- **Storage/shading grid:** **equirectangular**, 8192×4096, **RGBA32F**, U-wrapped in
  longitude, V-clamped at poles. All real Earth DEM/SatMap I/O is equirect.
- **Texture precision:** **RGBA32F for every erosion ping-pong target** (height,
  water, 4-direction flux, velocity, sediment). RGBA16F is *forbidden* for erosion
  state — per-step deltas (~1e-4) underflow half-float at terrain magnitudes (shipped
  reference `LanLou123/Webgl-Erosion` uses 32F for all targets). Requires
  `EXT_color_buffer_float`; absence is a hard-fail with a clear error.
- **Float-linear (NORMATIVE):** `EXT_color_buffer_float` enables *rendering* to
  float but NOT bilinear *sampling* of it — `OES_texture_float_linear` is a
  separate extension, absent on some Apple-Silicon/mobile. It must be probed
  separately; if absent, float RTs use `NearestFilter` and the pyramid-upsample
  + cube→equirect resample shaders do an explicit **4-tap manual bilinear** (a
  silent nearest fallback stair-steps and destroys dendritic networks).
- **Mask precision is PER-TARGET, not blanket 32F (NORMATIVE):** 8×RGBA32F@8K =
  ~4.3 GB ⇒ guaranteed WebGL context loss. The mask library assigns format per
  channel-group: **RGBA8** for unorm masks (biomeId, weights, variations,
  base-temp, wetness, frontier…), **RGBA16F** only for geometric/SDF/AO data,
  **RGBA32F** only where strictly required. Documented in the mask layout.
- **MRT split (NORMATIVE):** WebGL2 guarantees only `MAX_COLOR_ATTACHMENTS = 4`
  (many integrated/Apple GPUs cap at 4). Mask generation must query the limit
  and run in ≥2 passes (≤4 targets each), never one ≤8-target draw.
- **Flux layout:** pack the 4 pipe outflow directions as a single RGBA32F texture
  (canonical Mei-2007 layout).
- **Sediment advection:** MacCormack (semi-Lagrangian alone smears rivers).
- **Determinism:** fixed seed + fixed iteration counts ⇒ byte-reproducible bakes.
- **Bake-then-watch:** P3 is an offline job with a progress UI (multi-second at 8K;
  no public WebGL impl does 8K pipe erosion live — `LanLou` tops out at 1024²). P6
  shading is always instant/live on the last baked result.
- **Cube-face seams (bake-only):** the 6 faces exchange a border halo *each erosion
  iteration*. This is tractable precisely because erosion is offline (the live
  cross-face cost the user objected to earlier does not apply to a bake).

## 5. Subsystem A — Raster bake + multi-scale amplification erosion

**Files (new):** GPU pass orchestration + GLSL in the viewport layer; Rust bake
command + CPU reference oracle. Exact paths fixed in the A sub-spec.

### 5.1 Cube-sphere solve

- 6 faces, each a 2D RGBA32F grid. Per-cell area ≈ uniform (equal-area projection),
  so flux/slope/drainage are isotropic — no cos(lat) correction, no pole freeze.
- Per erosion iteration, each face reads a 1-cell (configurable halo width) border
  from its 4 neighbour faces so flow is continuous across face edges. Halo exchange
  is a fixed adjacency (cube topology) — deterministic, offline.
- **HARDENING — cube-corner singularities (NORMATIVE):** the 8 cube corners are
  three-way face junctions where the 4-direction Mei flux layout has no orthogonal
  neighbour. The halo-exchange pass must explicitly special-case the 8 corner texels:
  (a) neighbourhood lookup is a **3-way distribution** (not 4), and (b) any flux pipe
  crossing a face edge near a corner must **reorient its direction by ±90° or ±180°**
  into the destination face's coordinate space. Without this, sediment pools
  permanently on the 8 corners. Corner adjacency + per-edge rotation is a fixed,
  precomputed table (cube topology is static). **(c) Gradient/Laplacian at
  corners:** the symmetric finite-difference dx/dy is undefined with only 3
  neighbours (collapses → NaN/∞ slope, propagates). Stream-power slope and
  thermal Laplacian at the 8 corner texels must be computed from the
  **least-squares plane through the 3 available adjacent vertices** (sphere
  positions + heights), and the FV Laplacian sums only the 3 real fluxes (no
  zero-filled phantom 4th).

### 5.2 P1 rasterize

Sample the painted Goldberg field into each cube-face grid by barycentric cell
interpolation. Ocean cells flagged (excluded from erosion; fixed base level).
Two input regimes share this path: painted macro (≈600k cells ⇒ mostly synthetic
detail downstream) and the real Earth-DEM template (real detail). Both are valid.

### 5.3 P2 orographic proxy

Low-res prevailing-wind raymarch over `h0` → `C_proxy` (orographic precipitation +
macro slope). Steers detail injection so windward faces carve hard and lee faces
stay intact (directional realism; pre-empts the India/Indochina rain-shadow class
of bug). `C_proxy` is *erosion steering only*; the authoritative climate masks are
recomputed post-erosion in P5.

**NO CIRCULAR DEPENDENCY (NORMATIVE):** `C_proxy` is computed **solely from the
pre-erosion macro `h0`** by an *isolated* function that runs **before** P3. It is
NEVER derived from `h_final` (P3 consumes `C_proxy`, so deriving it from the
erosion output would be circular). Subsystem B owns the climate code, but its
`compute_cproxy(h0)` entry is callable standalone and is invoked at P2; B's
`h_final`-based climate masks (temperature/precip/biome…) are a *separate*,
later computation that does not feed erosion.

### 5.4 P3 multi-scale amplification

Pyramid, coarse → fine, factor ×2 per level (recipe verbatim from
H-Schott/MultiScaleErosion, SIGGRAPH 2024). Per level:

1. Inject a detail band: domain-warped fBm, ridged near orogenic belts; amplitude =
   f(macro slope, `C_proxy`). **The band generator must be deterministic and
   continuous across face seams** (use sphere-position-domain noise, not per-face UV)
   — discontinuous bands are the #1 amplification artefact (drainage breaks at level
   transitions).
2. **Erode → thermal (talus-angle-clamped) → deposition** (this order is normative).
   **HARDENING — thermal must not out-diffuse the injected detail band (NORMATIVE;
   this is the primary cause of the net-smooth defect):** running `thermal_step`
   every K-iteration (16×/level × levels) diffuses the just-injected sub-macro
   relief ~150× away *before* the §5.5 blend ever runs (empirically: injected
   `var(h−lowpass)` at a level → ~0.6% survives to the blend). `thermal_step`
   MUST be throttled relative to detail injection / stream-power so that, on a
   smooth-flank fixture, the **pre-blend finest field retains ≥ 50% of the
   injected sub-macro variance** (`var(h − lowpass)` at the §5.5 cutoff).
   Concretely: `ErosionConfig` carries `thermal_cadence: u32` (default `8` —
   empirically the smallest cadence clearing the ≥50% retention contract:
   measured 4→0.348, 6→0.421, 8→0.538 plateau) and `thermal_step` runs only
   every `thermal_cadence`-th K-iteration, NOT every iteration. Talus-gated
   creep (`talus_angle≈0.6`) is for steep-slope/scree relaxation only; it must
   leave the slope-modulated detail band substantially intact. A10's unit test
   asserts this retention at the thermal stage (via the `run_pyramid_stages`
   hook) so the regression is caught where it originates. NOTE: the holistic
   "erosion adds genuine dendritic detail / is not net-smooth" claim is **not**
   numerically unit-testable at unit scale (the §5.5 blend β-amplifies the A9
   PD/bilinear faceting band; a blend-processed no-erosion reference is the band
   maximum, not ≈0) — it is gated **visually at full bake resolution** in A19
   Step 2b (no-erosion vs erosion side-by-side), per the standing "validate sim
   visually" rule. The retention contract + the cadence-1 throttle regression
   guard are the rigorous numeric guards; visual is the fidelity gate.
   - **Coarse levels: stream-power incision** (drainage-area law; cheap,
     multi-scale-friendly — the SIGGRAPH-2024 choice). Reuse the existing tested
     Rust stream-power math as the CPU reference / optionally the coarse operator.
   - **Finest 1–2 levels: full Mei-2007 virtual-pipe model** (water → 4-dir flux →
     water/velocity → erode/deposit → MacCormack sediment advection → thermal
     slippage → evaporate; ~9 ping-pong passes/step; K≈16 iters/level is realistic).
3. Upsample ×2 **carrying height + water + sediment** (not height alone — else
   drainage restarts and macro channels break at the transition).
   **HARDENING — conservative fluid upsampling (NORMATIVE):** `h` may be
   bilinear/sampled, but the water depth `d` and sediment `s` tensors must be
   split with a **mass-conserving area-weighted** layout: when a coarse texel
   splits into 4 fine texels, `Σ d_fine = d_coarse` (and likewise `s`) exactly.
   Naïve bilinear upsampling of `d`/`s` spontaneously creates/destroys fluid at
   level boundaries and breaks dendritic continuity.
   **HARDENING — post-upsample pit removal (NORMATIVE):** bilinear-upsampled `h`
   manufactures artificial local minima between coarse samples; the (correctly)
   conserved `d` then pools in those phantom pits next iteration and severs
   rivers. Mandatory order per level transition: **upsample `h` → monotonic-
   downhill / depression-fill pass on the fine `h` → only then place the
   conserved `d`/`s`.**

`U=0`; per-step incision clamped to `ε` (normalized units; start ε≈3e-4, tune).

### 5.5 Macro preservation (frequency separation — NOT lerp)

**Canonical blend (NORMATIVE — World Machine Frequency-Splitter form):**
`h_final = lowpass(h0) + β·(h_eroded − lowpass(h_eroded))`. At `β=1` this is
exactly *macro from `h0`* + *full high-frequency detail from `h_eroded`*. Naive
`lerp(h0, h_eroded, β)` washes out macro relief and is rejected. `lowpass` kernel
cutoff = the largest drainage-basin radius to protect (separable blur on the
pyramid, cheap at coarse).

**β is the detail-restoration GAIN on the high-frequency erosion residual, NOT a
macro knob (NORMATIVE — corrects an earlier spec contradiction):** `β` multiplies
`(h_eroded − lowpass(h_eroded))`, i.e. the sub-macro erosion detail. Therefore
`β=1` = full-strength detail; `β>1` amplifies erosion relief; `β<1` *attenuates*
it (use ONLY to deliberately mute over-aggressive erosion). **The production
default MUST be `β ≥ 1`** — a sub-unity β suppresses *all* sub-macro relief and
net-smooths the output (empirically: `β=0.2` was the single most damaging default;
recommended default `β ≈ 1.5`, `macro_err` stays ≈10× under the 0.05 limit even at
`β=2`). The earlier "`β<1` lets erosion widen valleys/deltas" phrasing was wrong
and is deleted. A10's test pins post-blend sub-macro detail > plain-upsample
detail at the default β. Tuned and **validated visually** (per standing rule).

### 5.6 P4 resample

Cube-sphere `h_final` → equirect 8K RGBA32F by inverse-mapping each equirect texel
to its cube face/uv with bilinear fetch. Equirect is storage/shading only from here.

### 5.7 Bake UX, determinism, testing

- Progress UI; re-bake on paint change or erosion-param change; result cached as
  static textures consumed by P5/P6.
- **CPU reference oracle:** keep `hydrology.rs` stream-power as a low-res Rust
  reference; golden-image + numeric-tolerance tests compare a low-res GPU bake
  against it. Preserves the unit-test safety net the GLSL move otherwise loses.

## 6. Subsystem B — Mask library (computed once, post-erosion, equirect)

Honest cost framing: this is **many global passes**, not one. All seam-wrapped (U)
and pole-clamped (V).

- **Geometric (from `h_final`):** height, slope, normal, curvature, **AO** (baked
  multi-tap horizon occlusion), drainage/flow (final water + accumulation passes),
  deposition (sediment), wetness, river/stream, **thin-shoreline SDF** (jump-flood,
  narrow band), ridge/valley (curvature), **Flow-Accumulation SDF** (signed distance
  to the channel network where drainage > τ; smoothly widens riverbeds and blends
  riparian zones — avoids 1-px hard river lines — and supplies `localRelief` =
  height above the nearest channel, the SatMap LUT-X axis. **HARDENING (NORMATIVE):**
  (1) flow *accumulation* is NOT a naïve recursive/pointer-jumping parallel-flood
  over 33.5M texels (GPU TDR) — accumulate **hierarchically on the pyramid chain**
  (coarse→fine, reusing the §5.4 levels). (2) The *SDF itself* is computed with
  the **Jump-Flood Algorithm seeded by the river/channel mask** (the same JFA used
  for dist-to-ocean; O(log N), TDR-safe). A bilateral blur is explicitly **NOT**
  acceptable: it produces a resolution-dependent value gradient, not a Euclidean
  distance field.),
  **Wind-Shear / Exposure**
  (`dot(prevailingWindDir, terrainNormal)` from the ported climate engine's per-cell
  wind vector × `h_final` normal; >0 windward/scoured, <0 leeward/sheltered — drives
  dune alignment and windward bedrock exposure).
- **Climate (ported math, not re-invented):** insolation, base-temp **with
  continentality from final elevation** (also closes task #193), temperature,
  dist-to-ocean (seam-wrapped jump-flood — flagged fidelity change vs the geodesic
  BFS), precipitation (zonal + orographic on `h_final` + downwind moisture
  advection), **ocean-current ΔT with scientific domain-warp** (fBm-warped gyre).
- **Classification/transition:** biome (Whittaker), continuous biome-weight
  (per-texel ⇒ hex gone for free), **Sobel biome-frontier** → transition/blend band,
  a named set of **noise/pattern-break masks** (domain-warp + value/worley octaves).
- **Baked micro-bleed:** a small **fixed ~5–6px edge-aware** bleed is baked into the
  boundary/biome masks here (bilateral, hard-stopped at the Sobel frontier so it
  never crosses biomes). This is the *only* place spatial bleed happens. It is
  macro-invisible micro-cohesion, not a macro smooth-brush (consistent with the
  standing no-flat-brush rule). Strength is a bake parameter, not a live knob.
- **Procedural-noise catalog (bake-time generators):** `fbm` (3D simplex, relief
  detail), `ridged` (3D ridged-multifractal, mountain ridgelines), `worley` (3D
  cellular, cracks/patchiness/talus/biome patches), `domainWarp` (warps the sample
  position of the above; organic non-linear shapes; warps frontiers + ocean gyres).
  All evaluated at world sphere position ⇒ seam-free by construction, deterministic
  with fixed seed.
- **Named pattern-break / per-biome masks (all baked here):** `macroVariation`
  (low-freq fBm), `mesoDetail` (mid-freq fBm+worley), `edgeBreak` (domainWarp applied
  to every hard boundary — coast/biome/snow — so lines are organic, never straight),
  `noisePerturbedFrontier` (Sobel frontier wiggled by `edgeBreak`), and per-biome
  representation brushes `rockExposure` (= slope·curvature), `dune`, `vegetationPatch`
  (= worley).
- **ALU Bake Enforcement (NORMATIVE):** all multi-octave `fbm`/`ridged`/`worley`/
  `domainWarp` for the pattern-break + per-biome-brush masks **and** the frontier
  perturbation are evaluated **at bake time and written into MRT channels**. The live
  shader performs **zero multi-octave procedural math** — only O(1) texture taps,
  plus exactly **one** blue-noise tile tap for the live variation jitter (§7).
- Debug map-mode view for every mask (keep the EU5-style overlay).

## 7. Subsystem C — Live multi-layer SatMap shading (always-on; no texturing step)

Single-tap only. **No cross-texel sampling at render** (VT/CDLOD-safe). All regional
cohesion is the §6 baked micro-bleed; the only live noise is one blue-noise tap.

### 7.1 The SatMap atom

A SatMap is a **2D RGBA color texture used as a LUT** — never projected onto the
sphere as an image. Indexed per-texel by two physical scalars:

- **LUT-X = `localRelief`** — height **above the local drainage base** (from the
  Flow-Accumulation SDF: `localRelief = h_final − heightOfNearestChannel`,
  normalized), *not* raw planet elevation. Makes a desert dune vs mesa, and a
  Himalayan valley floor vs peak, both read correctly.
- **LUT-Y = `slope01`** — normalized slope.

`layerColor = texture(SM_layer, vec2(localRelief, slope01))` — one bilinear tap.

### 7.2 SatMap registry

Fixed-size 2D textures: `globalDry, globalWet, snow, flow, curvature, mountain,
+ one per biome`. Bilinear, clamp, single-tap.

### 7.3 The composite (exact order; all O(1) taps + 1 blue-noise tap)

```glsl
// inputs: O(1) taps from baked MRTs + live UI uniforms + 1 blueNoise tap
vec3 dry = texture(SM_globalDry, vec2(localRelief, slope01)).rgb;
vec3 wec = texture(SM_globalWet, vec2(localRelief, slope01)).rgb;
float w  = smoothstep(uWetLo, uWetHi, wet);   // wet=f(precip,drainage,distWater); curve LIVE
vec3 base = mix(dry, wec, w);

vec3 biome = vec3(0.0);                        // continuous weights -> no hex
for (b in topBiomes) biome += biomeW[b]*texture(SM_biome[b], vec2(localRelief,slope01)).rgb;
float edgeMix = noisePerturbedFrontier;        // baked: Sobel wiggled by edgeBreak
base = combineOverlay(base, biome, mix(hardBiomeMask, 1.0, edgeMix)); // crisp interior, organic edge

base = combineMax(base, texture(SM_flow,      vec2(flowSDF,    slope01)).rgb,
                        riverMask  * (0.6 + 0.4*edgeBreak));
base = combineMax(base, texture(SM_curvature, vec2(curv,       slope01)).rgb,
                        ridgeValley* (0.6 + 0.4*edgeBreak));
base = combineMax(base, texture(SM_mountain,  vec2(localRelief,slope01)).rgb,
                        rockExposure*highAlt*(0.7 + 0.3*windExposure));
base = applyBiomeBrush(base, biomeId, dune*windExposure, vegetationPatch, mesoDetail);

base = mix(base, texture(SM_snow, vec2(localRelief,slope01)).rgb,           // snow LAST
                 snowMask * (0.6 + 0.4*edgeBreak));

base *= 1.0 + uVarAmp*(macroVariation - 0.5);            // baked large-scale variation
base  = mix(base, texture(SM_cohesion, uv).rgb, uCohesion); // baked ~5-6px micro-bleed (1 tap)
base += uJitterAmp*(blueNoiseJitter - 0.5);              // ONLY live noise tap

base *= pow(AO, uAOStrength);
base  = mountainStandout(base, slope01, curv, normal);
fragColor = tonemap(base*sunLight + atmosphere);
```

**Every blend is noise-masked Combine/Overlay/Max, never flat alpha** (Gaea
anti-seam; flat opacity is the forbidden "smooth brush"). Biome interiors are
winner-take-all (crisp); blending happens **only inside `noisePerturbedFrontier`**.

### 7.4 "Onto Earth" (concrete)

Masks (from `h_final`) pick *which* SatMap + wet/dry mix per equirect texel; the
`(localRelief, slope)` coordinate picks the color *within* it:
- **Sahara:** desert biome, `wet`≈0 → `globalDry`×`SM_biome[desert]`; `dune·windExposure`
  aligns dunes; low `localRelief`→sand, mesa tops→rock.
- **Amazon:** tropical, `wet`≈1 → `globalWet`×`SM_biome[rainforest]`; `vegetationPatch`
  mottles; rivers via `SM_flow` widened by `flowSDF`.
- **Himalaya:** high `localRelief`+steep+`snowMask` → `SM_mountain` windward rock
  (`windExposure`>0), `SM_snow` on top, ragged by `edgeBreak`.

### 7.5 Live vs baked

- **Live knobs (cheap):** per-layer opacities, `uWetLo/uWetHi`, `uVarAmp`,
  `uJitterAmp`, `uCohesion`, `uAOStrength`, mountain-standout contrast.
- **Baked (re-bake to change):** every mask, the micro-bleed/cohesion, all
  multi-octave noise (ALU Bake Enforcement, §6).

## 8. Subsystem D — Renderer quality

- Multiply baked **AO** into albedo.
- **Mountain standout:** slope/curvature-aware contrast + mountain-detail SatMap +
  normal-mapped relief lighting; configurable in Shading Settings.
- Atmosphere/lighting tuning toward the photoreal-Earth-from-orbit target stays the
  north star (see project memory) but is scoped in the D sub-spec.

## 9. Phase 2 — zoom detail amplification (deferred, behind the interface)

- **Interface contract (Phase 1 must ship this):** `sampleField(lonlat) →
  { height, masks… }`. Phase 1 backs it with the 8K global equirect (Phase-2 stub
  returns the global level). Subsystems B/C/D consume only this.
- **Phase 2 = CDLOD / geometry-clipmap quadtree** of higher-res heightmap tiles
  (NOT GPU-feedback virtual texturing — `readPixels` feedback stalls WebGL2 with no
  compute). It performs **local detail amplification only; it does NOT re-solve
  drainage** (a tile's true catchment is continental and non-resident — standard,
  accepted approximation; matches the GameDev planet pattern).

## 10. Ported vs scrapped

- **Ported (kept):** the *math* of `climate.rs` (continentality, lapse, downwind
  moisture, ocean-current ΔT, Whittaker) re-expressed as equirect passes;
  `hydrology.rs` stream-power kept as CPU reference oracle / coarse operator.
- **Scrapped:** Plan-A per-cell Goldberg bake erosion; per-cell mask attribute
  packing in the shader (→ texture sampling); the `terrain-erosion-3-ways` mental
  model (it is grid-droplet O(N³), not the pipe model — used only for the O(N³)
  argument that *justifies* the pyramid; the GPU port reference is
  `LanLou123/Webgl-Erosion`).

## 11. Testing & determinism

- Fixed-seed reproducible bakes (byte-stable).
- Low-res CPU Rust reference (stream-power + ported climate) → golden-image and
  numeric-tolerance tests for erosion + climate.
- Visual validation at high latitudes and across the cube-face seams early (the
  former equirect risk now mitigated by the cube-sphere solve, but verify).
- Per standing rule: validate sim features *visually*, not just metric counts.

## 12. Phasing & risks

**Build order (forced by dependencies):** A → B → C → D. Each gets its own sub-spec
+ plan under this umbrella.

**Phase 1 = the entire 8K-global vertical slice** (A+B+C+D) with Phase-2 tiling
stubbed behind `sampleField()`. Something real on screen before any tiling work.

**Top residual risks:**
1. Cube-sphere face-seam continuity under iterated erosion (halo width / cadence) —
   visual-validate at seams early.
2. Detail-band determinism/continuity across seams (sphere-domain noise mandatory).
3. RGBA32F render+blend hardware support (`EXT_color_buffer_float`) — hard-fail
   with a clear message if absent.
4. 8K bake wall-clock (multi-second acceptable per bake-then-watch; budget K and
   pyramid depth).
5. Mask library pass count at 33M texels — the real GPU cost centre; measure.
6. Cube-corner singularities — sediment pooling on the 8 corners if the halo pass
   doesn't special-case 3-way junctions + flux reorientation (§5.1 hardening).
7. Non-conservative `d`/`s` pyramid upsampling — fluid created/destroyed at level
   seams, breaks dendritic continuity (§5.4 hardening: area-weighted split).
8. Flow-Accumulation TDR — naïve parallel-flood over 33.5M texels times out;
   hierarchical-on-pyramid or bilateral-blur approximation only (§6 hardening).

## 13. Reference implementations (port/study targets)

- `LanLou123/Webgl-Erosion` — WebGL Mei-2007 pipe model, RGBA32F, ~9 passes/step
  (primary GPU port reference).
- `H-Schott/MultiScaleErosion` (SIGGRAPH 2024) — multi-scale amplification recipe
  (erode→thermal→deposition + ×2).
- Frozen Fractal "Around The World" 11/23 — cube-sphere planet erosion rationale.
- GameDev.net "Real-time Planet-scale Erosion" — hierarchical Mei across LOD tiles
  (carry fluid+sediment; ~16 iters/level).
- World Machine Frequency Splitter/Combiner — frequency-separation pattern.
- Gaea SatMap/Combine docs — layer order + noise-masked Combine/Max.
- Jákó, CESCG 2011 "Fast Hydraulic and Thermal Erosion on the GPU" — pipe-model GPU
  recipe.
- `dandrino/terrain-erosion-3-ways` — O(N³) propagation argument + parameter
  ballpark only (NOT a pipe-model reference).
