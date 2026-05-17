# Gaea-Faithful Erosion Port — Design Spec

**Date:** 2026-05-16
**Branch / worktree:** `feat/baking-pipeline` · `D:\Hackathons\hayba\.claude\worktrees\baking-pipeline-fix`
**Supersedes erosion internals of:** `2026-05-16-erosion-rework-hydraulic-design.md` (the Mei-2007
virtual-pipes core is kept as the hydraulic substrate; everything around it is
re-architected per this spec).
**Source research:** `D:\Projects\shadingvents\GAEA_SIMULATOR_FINDINGS.md` +
decompiled C# at `D:\Projects\shadingvents\gaea_decomp\` (algorithms extracted
and inlined below — the decomp is reference, not a dependency).

---

## 1. Goal

Make the post-paint planet erosion look like Gaea-grade terrain: gentle and
physically controllable (not "way too strong"), with **properly formed mountain
ridgelines**, dendritic river valleys, and natural coastlines — and a
**view-dependent level of detail** so the planet is clean when zoomed out and
reveals simulated micro erosion only as the camera zooms in.

Validation is **visual on the real GPU** (the standing project rule), backed by
Rust unit tests and the headless real-GPU numeric/golden-image loop.

## 2. Why the current pipeline is insufficient

| Symptom (user, observed) | Root cause |
|---|---|
| Erosion "way too strong" | Macro-preservation is an ad-hoc per-step `maxDeltaB` clamp + `uplift`, not physical. Strength is a magic unitless number, not anchored to metres. |
| "No properly formed mountain ridges" | The sim is single-sediment hydraulic + isotropic FBM. Ridgelines come from **anisotropic thermal/talus**, which we do not have as a real pass. |
| "Too many noisy texels when zoomed out" | One fixed equirect grid; high-frequency detail is always on at all zooms. No multi-scale band separation, no LOD. |
| Coastlines look rasterised / hex | The rasteriser writes a continuous IDW+FBM field (good) but there is no shore-profile model (shelf/beach/cliff). |
| Detail wasted on ocean/flatland | Erosion + FBM amplitude is uniform; the user wants it concentrated on high/steep terrain. |

## 3. Architecture — two-tier, view-dependent

```
                 painted draft + climate precip
                              │
              ┌───────────────┴───────────────┐
              ▼                                ▼
   MACRO BASE BAKE (always)         FOCUSED DETAIL TILE (on zoom)
   global equirect, modest res      visible lat/lon window, fine dx
   S4 → S1 → S2(macro bands)        S4 → S1 → S2(detail bands)
              │                                │
              └──────────────┬─────────────────┘
                             ▼
        planet/relief shader composites: macro everywhere +
        detail tile where it covers, apron-feathered (no seam)
        zoomed out → macro only (clean) · zoomed in → tile detail
```

- **Macro base** — one global equirect bake at a modest resolution, gentle
  metre-scale erosion. Always visible. This is the "clean when zoomed out"
  layer; it carries the painted continent silhouette.
- **Focused detail tile** — when the camera settles after zooming past a
  threshold, the visible lat/lon AABB (plus an apron margin) is re-rasterised
  and re-eroded at a much finer effective `dx` (Gaea resolution-independence,
  inverted: a smaller ground window at the same texel budget ⇒ more
  metres-of-detail resolved). Composited over the macro base with an
  apron-feathered alpha so the shared macro band makes the seam invisible.

This realises the user's chosen "**view-dependent re-bake of focused tile**"
LOD model.

## 4. Subsystem S1 — World-scale parameter model

**Files:** `src-tauri/src/bake_equirect.rs` (param plumbing),
`src/viewport/bake/hydraulic.ts` (config), `src/viewport/bake/hydraulic.glsl.ts`
(uniforms + per-pass physics). New shared type.

Add to the bake config:

| Param | Meaning | Units | Default |
|---|---|---|---|
| `terrainScale` | ground width the grid spans | metres | macro: planet circumference `2πR`; tile: window arc width |
| `verticality` | what height `1.0` represents | metres | 9000 (Everest-ish span) |
| `featureScale` | target erosion wavelength | metres | 2000 |
| `duration` | sim time integrated | steps | tuned (replaces step count as the strength knob) |
| `strength` | erosion/thermal rate | dimensionless | tuned, small |
| `downcutting` | vertical incision rate | dimensionless | 0.25 |

Derived inside the sim (Gaea's mechanism, verbatim from §10 of findings):

```
dx     = terrainScale / resolution          # metres per texel
z_m(h) = h * verticality                     # real elevation, metres
slope  = Δz_m / dx                           # TRUE slope (dimensionless)
zCoeff = terrainScale / (verticality * resolution)
```

`tan(talusAngle)`, the three sediment discharge angles, sediment capacity and
`downcutting` are all evaluated against this **true metre slope**, integrated
over `duration`. This is the *only* strength model — the old per-step
`maxDeltaB` clamp and `uplift` term are **removed**. Macro preservation is now a
property of the band split (S2.5), not a clamp: erosion runs on the detail
bands; the macro band (the painted silhouette) is reconstructed untouched.

Because `dx` shrinks when `terrainScale` shrinks (a zoomed tile), the *same*
physical parameters automatically produce finer incision on tiles — no
per-tile retuning.

## 5. Subsystem S2 — Erosion morphology

GPU passes on the equirect grid/window, run on the existing raw-WebGL2
`glPass` runner. Ported from the decomp (formulas inlined).

### 5.1 Multi-sediment hydraulic (`parallel_erosion`)

Extend the existing single-sediment ERODE/ADVECT to **three sediment classes**,
each with a discharge (repose) angle and amount:

| Class | Discharge angle (default) | Amount (default) |
|---|---|---|
| Suspended (fines) | 24° | 1.0 |
| Mixed / bed | 15° | 0.0 |
| Coarse | 10° | 0.0 |

Per texel per step:

```
shear   = pow(flowAccum, m) * pow(slope, n)        # m=0.5, n=1
for each class i:
  cap_i = kTransport * shear * angleFactor(disAngle_i, slope)
  if load_i > cap_i:  deposit (load_i - cap_i),  height += deposit, load_i = cap_i
  else:               erode (cap_i - load_i)*rockSoftness*downcutting,
                      height -= erode,           load_i += erode
advect each load_i downstream along the flow vector (existing ADVECT)
wear += Σ eroded_i ;  deposition += Σ deposited_i
```

`flowAccum` comes from S2.3. `slope` is the S1 true metre slope. Outputs the
existing eroded height plus `flow`, `deposition`, `wear` channels (used by S4
and the renderer).

### 5.2 Anisotropic thermal / talus — **the ridgeline pass**

New GPU pass (generalises the existing `thermalEvery` hook). For each texel,
over its 8 neighbours:

```
s = (z_m[self] - z_m[nbr]) / dist_m
if s > tan(talusAngle):                       # talusAngle default 32°
  excess = (s - tan(talusAngle)) * dist_m * 0.5
  effStrength = strength * (1 + anisotropy * dirBias(nbr))   # anisotropy ∈ [0,1]
  move = excess * effStrength * duration
  height[self] -= move
  height[nbr]  += move * (1 - sedimentRemoval)
```

`dirBias` projects the neighbour offset onto a per-cell preferred axis
(derived from the local gradient / a low-freq noise field) so talus relaxation
is **direction-dependent** → striated, bedded slopes and sharp ridgelines
instead of conical talus. This pass is what produces "properly formed mountain
ridges". Run every `thermalEvery` hydraulic steps.

### 5.3 Flow-mask rivers

Accumulate discharge from the existing virtual-pipes WATER/FLUX passes into a
`flowAccum` field. Threshold: `river = smoothstep(t0, t1, flowAccum)`. Where
`river > 0`, carve channel depth `-= riverDepth * river * downcutting` and
widen by one texel via the talus pass. This yields visible dendritic river
valleys (Gaea Rivers, GPU-side).

### 5.4 Elevation / slope-gated detail (inhibitor mask)

A single `detailMask = clamp(elevGate(z_m) * slopeGate(slope), 0, 1)` where
`elevGate` rises above a mid-elevation threshold and `slopeGate` rises with
steepness. **All high-frequency contributions** — the rasteriser
sub-cell FBM amplitude, the detail-band erosion intensity (S2.5),
thermal `strength` — are
multiplied by `detailMask`. Effect: micro detail is strong on steep high
terrain (mountains), ~zero on ocean floor and flat lowlands. Directly the
user's "mask at mountain heights; spare ocean/flatlands".

### 5.5 Laplacian / spectral band split

Decompose the input height into a low-frequency **macro band** + one or more
**detail bands** using the Gaea separable kernel:

```
downsample: res >> 1
upsample (reconstruct): weights [1, 26, 26, 1] / 170 (separable 2×2)
detailBand = height - upsample(downsample(height))
```

Erosion (S2.1–S2.4) runs on the **detail band(s)**; the macro band is
preserved and recombined (`reconstruct_previous_level`). This makes erosion
scale-independent and is *the* macro-preservation mechanism (replacing the
removed clamp). It is also the substrate S3 exploits: a zoomed tile simply
resolves more detail bands over the same macro band.

## 6. Subsystem S3 — View-dependent re-bake

**Files:** `src/viewport/bake/tileBake.ts` (new — orchestration & cache),
`src-tauri/src/bake_equirect.rs` (windowed rasterise),
`src/viewport/bake/debugMaterial.ts` (+ later the production planet shader:
macro+tile composite), `src/App.tsx` (camera-settle hook, wiring).

- **Windowed rasterise.** Generalise `bake_inputs_equirect` to
  `bake_inputs_equirect_window(draft, latMin, latMax, lonMin, lonMax, w, h)`.
  The texel→lat/lon→`dir`→blended-cell path is unchanged; only the loop
  bounds and the lon-wrap handling for windows crossing ±180° change. The
  full-globe call is the window `[-90,90]×[-180,180]` (proven equivalent by a
  Rust test).
- **Macro base.** On entering the bake view, one global windowed bake at
  modest resolution → the always-present clean layer.
- **Tile trigger.** Subscribe to camera changes; when the camera **settles**
  (debounced, ~150 ms idle) and is closer than a zoom threshold, compute the
  visible lat/lon AABB, expand by an **apron** margin, and pick `w×h` so the
  tile `dx ≈ featureScale / k` (finer the closer you are). Skip if a cached
  tile already covers the view at adequate resolution.
- **Async, no freeze.** Run rasterise + S1+S2 sim via the existing
  `scene.runBake` (bake-then-watch; the load-bearing raw-WebGL2 + single
  end-of-bake `resetState()` discipline is retained). The sim is chunked
  with event-loop yields (existing infra) so it never holds the main
  thread across a long stretch.
- **Interaction safety (single-flight + abort).** Tile re-bake is
  **single-flight**: at most one in flight; the camera-settle trigger
  fires only on true idle (debounced), and any camera movement while a
  tile bake is pending or running **supersedes** it — a pending request
  is dropped, a running one is cancelled at the next chunk yield (cheap,
  no partial composite shown) and re-evaluated once idle again. Rapid
  panning therefore enqueues *zero* extra bakes; it just keeps deferring
  the single next one. The **macro base stays rendered and interactive
  the entire time** (pan/zoom never blocks on a tile bake); a tile only
  ever *adds* detail on top once it lands.
- **Seam blend (derivative-continuous).** The tile shares the macro band
  with the base (S2.5), so only the **detail band** differs. Composite in
  the shader: sample macro base everywhere, add the tile's detail where it
  covers, scaled by an apron weight `w(d)` that goes 1→0 across the apron
  using the **quintic fade** `x³(6x²−15x+10)` (zero first *and* second
  derivative at both ends) — not a linear alpha. A linear ramp leaves a
  slope kink: even with C0-continuous height, the detail band's
  high-frequency derivative ramps in abruptly and the recomputed shading
  normal shows the seam as a lighting line. The quintic ramp makes the
  blended field C1 across the apron. **Normals are derived once from the
  final composited height field** (never macro-normals and tile-normals
  computed separately then mixed), so the gradient is consistent through
  the apron. Asserted by the seam metric (§9 / §10) measured on the
  *normal* field, not just height.
- **Cache + invalidate.** LRU cache keyed by (quantised lat/lon AABB, res).
  Invalidate **all** tiles + macro on any draft/paint/param change. Bounded
  tile resolution (VRAM) and a small LRU count.
- **Fallback.** A tile rasterise/sim failure logs and leaves the macro base
  showing — never a broken or half-baked view.

Result: zoomed out → macro only (the noisy-texel complaint is gone because
high-frequency bands are simply not composited at distance); zoomed in →
simulated micro ridges/incision from the focused tile.

## 7. Subsystem S4 — Sea-node coastline

**Files:** `src-tauri/src/sea.rs` (new), called from `bake_equirect.rs` after
rasterise, before upload. Ported from `Waters.Sea` / `Morphology`.

Per (windowed) rasterised height, with sea level from the ocean-flag
convention (`height < 0` is sea — invariant preserved):

1. **SDFs.** `landDist` and `seaDist` via a separable parabolic Euclidean
   distance transform (the monotone-envelope O(n) algorithm), then a small
   Gaussian blur.
2. **Shore profile.** Combine the two SDFs with the cubic smooth blends and a
   quintic fade, over `shoreSize` (horizontal) / `shoreHeight` (vertical):

   ```
   num          = max(k - |a - b|, 0) / k
   smoothMax    = max(a,b) + num^3 * k * 0.125
   smoothMin    = min(a,b) - num^3 * k * 0.125
   fade(x)      = x*x*x*(x*(x*6 - 15) + 10)         # quintic Perlin
   shoreT       = fade(clamp(1 - seaDist/shoreSize, 0, 1))
   height       = mix(landProfile, seaProfile, shoreT)
   ```

   producing a smooth shelf → beach → cliff instead of a hard rasterised
   edge.
3. **Coastal vs global sea.** A flood-fill (EdgeFill) from the domain edge
   classifies open ocean vs enclosed basins (lakes) so only true coast gets
   the shore profile.
4. **Cliff detail.** Optional fractal (value-noise FBM, reuse
   `climate::value_noise`) perturbs the shoreline where slope is high.

Outputs: reshaped height + `water` / `depth` / `shore` masks (consumed by the
renderer; also retires the parked coastline-hex pain, task #177). S4 runs
**before** S1/S2 so erosion acts on the shore-shaped coast.

**S4 runs on the macro base *and* on every focused tile** (not macro-only).
`shoreSize` / `shoreHeight` and the cliff-noise frequency are expressed in
**metres** and converted via the S1 `dx`, so the shore profile is the same
real-world shape at every resolution: the macro base gives the coarse
shelf/beach, and a zoomed tile resolves the *same* coast with finer cliff
and shore detail (consistent material, not a smooth low-res coastline
revealed up close). The shared macro band still carries the coast position,
so the S3 seam blend stays continuous across the apron.

## 8. Data flow

```
draft + precip
  → S4 sea shore-shaping (Rust, on rasterised window)
  → S1 scale params attached
  → Rust windowed equirect (global macro OR focused tile)
  → upload Base/Precip DataTextures
  → S2 GPU sim:  Laplacian split → {3-class hydraulic + anisotropic thermal
                  + flow incision} on detail bands, detailMask-gated → recombine
  → eroded RT (+ flow/deposition/wear/water/depth/shore)
  → S3 composite (macro base + apron-feathered tile)
  → relief/planet shader
```

## 9. Invariants & error handling

- **Ocean sign.** `base.r < 0 ⇒ ocean` must survive S4 + band split + blend.
  S4 clamps shore output sign-preserving; S2.5 recombination cannot flip
  sign (macro band carries it). Asserted numerically.
- **Seam continuity (C1).** Guaranteed by the shared macro band + a
  quintic (derivative-continuous) apron feather + normals derived from the
  single composited field (S3). Asserted by a low seam-ratio metric
  measured on the **normal/slope field** (not just height) across the
  ±180° wrap and tile edges — a height-only metric would miss the
  lighting-line artifact.
- **Interaction never blocks.** Tile re-bake is single-flight and
  abortable; camera movement supersedes a pending/running tile; the macro
  base stays live and interactive throughout (S3). Asserted by: rapid-pan
  stress in the real-app gate triggers ≤1 in-flight bake and no frame
  lock.
- **Longitude wrap / poles.** Retained from the hydraulic core (integer
  `(x%W+W)%W`, pole-band damping); windowed tiles crossing ±180° handle the
  wrap in the Rust loop.
- **Determinism.** All noise seeded; identical inputs ⇒ identical bake.
- **Resource bounds.** Tile resolution capped for VRAM; LRU evicts old tiles;
  tile failure ⇒ macro fallback.
- **No regressions to the fixed overlay/extrusion behaviour** (commit
  `d51837b`): the painter mesh and any baked globe still never co-render.

## 10. Testing strategy

- **Rust unit tests:** distance-transform correctness vs brute force;
  `smoothMin/smoothMax` + quintic `fade` against hand-computed values; S1
  `dx/z_m/slope/zCoeff` derivations; `bake_inputs_equirect_window` ≡
  full-globe on the full window (byte-equal); 3-class sediment conservation;
  band split/recombine round-trips the macro band.
- **Headless real-GPU loop** (existing `__headless_harness__`): per bake
  assert finite, ocean preserved, seam ratio ~0, and **ridge presence** via a
  curvature/слope statistic (negative-curvature ridgelines must exist where
  `detailMask` is high). Add **golden-image diffs** for the relief render.
- **Real-app visual confirmation** (the authoritative gate): gentle (not
  over-eroded), real ridges, zoom reveals micro detail, clean when zoomed
  out, natural coastlines, no GL errors — on the real Tauri + GPU instance.

## 11. File structure (drives the plan decomposition)

| File | Responsibility |
|---|---|
| `src-tauri/src/sea.rs` (new) | S4: SDF EDT, shore blend, flood-fill, cliff noise |
| `src-tauri/src/bake_equirect.rs` | windowed rasterise, S1 param attach, call S4 |
| `src/viewport/bake/hydraulic.glsl.ts` | S1 physics, S2 passes (3-class, anisotropic thermal, flow, mask, band split) |
| `src/viewport/bake/hydraulic.ts` | config (S1 params), orchestrate S2 pass order + band split |
| `src/viewport/bake/tileBake.ts` (new) | S3: camera-settle trigger, window calc, cache/LRU, fallback |
| `src/viewport/bake/debugMaterial.ts` | S3 macro+tile composite (debug relief; production shader later) |
| `src/App.tsx` | wire tileBake to camera + bake view |
| shared types | `EquirectInputs` + window/params (replace ad-hoc inline types) |

## 11b. Future direction (tracked, NOT this spec): live-streamed planetary evolution

Watching the planet evolve in real time during the planetary-evolution
phase (vs. bake-then-view) is **feasible on this architecture and a natural
capstone after S3** — do NOT pull it into S1–S4 scope. Enablers already in
place: the GPU ping-pong sim is incremental (an RT per step); the Tauri
`bake_inputs_equirect` command is async + `spawn_blocking` (Task 10) so the
backend can step + `emit` without freezing the UI; S3's async/single-flight/
abortable/macro-stays-live re-bake is ~80% of the streaming plumbing.
Design sketch: keep the evolving field GPU-resident and let the display
material sample the live ping-pong RT each frame (no pixel IPC); stream only
deltas/downsampled previews over IPC (a full 2048×1024 RGBA32F frame ≈ 33 MB
is too much); run K sim steps per displayed frame. **Load-bearing risk:**
interleaving raw-WebGL2 `glPass` compute with three.js render frames
per-frame re-enters the GL-state-contamination class behind the historical
feedback-loop saga — needs the per-pass isolation + a single controlled
`resetState()` resync applied once per displayed frame, not naively mixed.
Revisit only after S3 lands.

## 12. Out of scope (YAGNI)

- Porting Gaea's SYCL/ISPC kernels literally — we reimplement the *algorithms*
  on our WebGL2 stack, not the binaries.
- Aeolian/dune (`arrakis`), debris, color-transport, snow simulators.
- The production planet renderer (Subsystem D) beyond the debug-relief
  composite needed to validate S3; final shading is a separate spec.
- Multi-resolution tile *pyramids* (more than one detail level per tile) —
  one focused tile over one macro base first; revisit only if zoom range
  demands it.

## 13. Open decisions (resolve in the plan, not blocking)

- Exact band count (1 vs 2 detail bands) — start with 1, measure.
- Tile apron width and camera-settle debounce — start 10 % AABB / 150 ms;
  the abort/supersede logic (S3) makes the debounce value non-critical.
- (Resolved per review) S4 runs on macro **and** per tile, scale-aware —
  see §7. No longer open.
