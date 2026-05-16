# Erosion Rework — Virtual-Pipes Hydraulic on Equirect (Design)

**Date:** 2026-05-16
**Status:** Approved (brainstorm) — pending spec review → writing-plans
**Supersedes:** the bespoke cube-sphere multi-scale graph/stream-power bake
(`docs/superpowers/specs/2026-05-15-baking-pipeline-redesign-design.md` and its
A–D plans) — that approach is DEAD.

## Why this rework

The bespoke cube-sphere → multi-scale pyramid → graph + stream-power + thermal
+ frequency-separation pipeline (Rust oracle + GPU port, CPU↔GPU parity) was
enormous, fragile, and after a multi-day debugging saga still produced **no
usable output**. The WebGL feedback-loop class of bug was finally fixed by a
raw-WebGL2 pass runner (`glPass.ts`, kept), but the bespoke erosion algorithm
itself never yielded a result. Decision: scrap it and rebuild erosion as a
**small, proven, self-contained GPU grid hydraulic simulation** in the spirit
of the referenced Shadertoy shaders (XttcWn / XsVBRm family — Mei et al. 2007
"virtual pipes"). Lowest risk to a working, terrain-responsive result.

## Brainstorm decisions (locked)

- **Q1 — fidelity:** a *simple hydraulic simulation that responds to terrain*
  (emergent dendritic drainage), NOT procedural-noise-only and NOT the scrapped
  graph/stream-power monster.
- **Q2 — domain:** ONE **equirectangular** height grid; longitude wraps
  (left↔right); poles damped. NO cube-sphere / cross-face handling (the prime
  source of the failures).
- **Q3 — rainfall:** **climate-precipitation coupled** — erosion samples the
  existing climate precipitation map. Bake order becomes **climate → erosion**.
- **Q4 — target output:** the eroded terrain **shapes** — sharp incised
  ridgelines, branching dendritic valleys, canyon/mesa structure, drainage that
  carves the land. (Lighting/colour is the separate renderer layer; explicitly
  out of scope here.)
- **Approach A — virtual-pipes shallow-water hydraulic erosion** (Mei 2007),
  the proven Shadertoy-family grid model.

## Scope: scrap vs keep

**DELETE:**
- Rust `src-tauri/src/erosion/` (pyramid.rs, cubesphere.rs, resample.rs,
  noise.rs, mod.rs) and its module registration.
- Tauri commands `bake_erode_v2`, `bake_h0_v2` (and their `lib.rs`
  registration).
- TS `src/viewport/bake/erodePipeline.ts`, `passes.glsl.ts`, `parity.ts`,
  `cubesphere.ts`, `uploadH0.ts`.
- All dev instrumentation in `pingpong.ts`
  (`physicallyIsolateUnits`, `_bakeDebug`, `_bakeUnitHygiene`, SELF-ALIAS /
  GL-ALIAS / STALE-UNIT-ALIAS / bake-summary, `runPass`, `PingPongBook`) and
  the App.tsx "Run parity" button.
- The CPU-oracle-TDD + CPU↔GPU parity harness concept (no Rust oracle exists in
  the new design; validation is visual — see Testing).

**KEEP:**
- `src/viewport/bake/glPass.ts` — the raw-WebGL2 pass runner (own FBO/units;
  feedback loop structurally impossible). This is the proven foundation.
- `pingpong.ts` **reduced** to: `decideFloatSupport` (the
  `EXT_color_buffer_float` / `OES_texture_float_linear` probe) and the
  RGBA32F render-target allocation helper (`createPingPong`/`makeRT`-style).
  Everything bespoke/instrumented is removed.
- `debugMaterial.ts` — the sphere→equirect relief material with the
  `h0` vs eroded toggle (used for visual before/after validation).
- The bake-then-watch model (`scene.runBake` pauses the render loop, awaits the
  bake, resumes) and the single end-of-bake `renderer.resetState()` (so three
  resyncs before the app renders the result globe).
- The painting/draft system, the climate (precipitation) system, and the
  masks/SatMap downstream consumers.

## Architecture

One equirectangular grid, width `W` × height `H` (debug default `W=1024,
H=512`; configurable up for final bake). All sim textures are RGBA32F,
ping-ponged via `glPass.runRawPass`. Longitude wraps: every horizontal
neighbour/advection sample uses `x' = mod(x + dx + W, W)`. Latitude clamps at
the poles; rain and erosion are damped to zero over the polar caps via a
latitude falloff `wLat = smoothstep(1.0, 1.0 - POLE_BAND, abs(2*v - 1))` where
`v` is the normalized row (0..1) — i.e. erosion/rain → 0 in the top/bottom
`POLE_BAND` fraction of rows (default `POLE_BAND = 0.04`). Earth-like worlds
are ice/ocean at the poles so this is visually inconsequential.

### State & input textures (minimal)

- **`A`** (ping-ponged): `r = b` terrain height, `g = d` water depth,
  `b = s` suspended sediment, `a = ocean` flag (`1.0` if base height < 0).
- **`F`** (ping-ponged): `r,g,b,a = ` outflow flux to Left, Right, Bottom, Top.
- **`Base`** (static input, DataTexture): `r =` rasterized painted elevation
  (continents > 0, deep ocean < 0, unpainted = deep-ocean floor).
- **`Precip`** (static input, DataTexture): `r =` climate precipitation,
  normalized 0..1.

`A` and `F` each need two RTs (read/write). ≈ 4 RTs + 2 static DataTextures.

### Coordinate convention (fixed, documented once)

Equirect texel `(rx, ry)`, `rx∈[0,W)`, `ry∈[0,H)`. **Row `ry = 0` is the
North pole row.** `lat = 90° − (ry + 0.5)/H · 180°`,
`lon = (rx + 0.5)/W · 360° − 180°`. The Rust rasterizer, the GLSL passes, and
`debugMaterial.ts`'s sphere→equirect sampling all use exactly this convention
(documented in each).

## Data flow

```
paint draft ─▶ Rust bake_inputs_equirect(draft, W, H)
                    │  (climate computed first, then sampled)
                    ▼
              { height[], precip[] }  ──▶ equirectInput.ts ─▶ Base, Precip DataTextures
                                                                   │
hydraulic.ts: init A (b=Base, d=0, s=0, ocean=Base<0), F=0          │
   loop N steps (chunked, yielded):  ◀──────────────────────────────┘
     pass1 Rain · pass2 Flux · pass3 Water+Vel · pass4 Erode/Deposit ·
     pass5 Advect sediment · pass6 Evaporate · [pass7 Thermal every K]
   ─▶ eroded equirect = A.r  ─▶ debug relief globe + downstream masks/SatMap
```

No cube-sphere, no resample (already equirect). One `renderer.resetState()`
after the loop, before returning the result RT.

## The simulation step (concrete equations)

Constants/params (named, tunable; concrete numeric defaults pinned in the
implementation plan, not here): `dt`, `rainScale`,
`gravity g`, pipe area `Ap`, cell length `l` (=1 grid unit), capacity `Kc`,
erode rate `Ks`, deposit rate `Kd`, evaporation `Ke`, min tilt `sinMin`,
uplift `upliftRate`, `maxDeltaB` (per-step incision/deposition clamp), thermal
`Kt`, talus `tanTalus`, `thermalEvery K`, `POLE_BAND`. All sampling
longitude-wrapped; ocean cells (`A.a > 0.5`) never erode below sea and act as a
fixed water reservoir.

1. **Rain** — `d += dt · rainScale · Precip(rx,ry) · wLat`. (Climate coupling.)
2. **Flux** — for each neighbour `X∈{L,R,B,T}` (x wrapped):
   `Δh_X = (b + d) − (b_X + d_X)`;
   `f_X = max(0, f_X_prev + dt · Ap · g · Δh_X / l)`.
   Scale to conserve water:
   `K = min(1, d·l·l / ((fL+fR+fB+fT)·dt))` (if sum>0, else 0); `f_X *= K`.
3. **Water + velocity** —
   `ΔV = dt · ( Σ inflow(neighbours' flux toward this cell) − (fL+fR+fB+fT) )`;
   `d' = max(0, d + ΔV/(l·l))`;
   `vx = ( f_R(left) − fL + fR − f_L(right) ) / 2`,
   `vy = ( f_T(below) − fB + fT − f_B(above) ) / 2`;
   `v = (vx, vy) / max(eps, l · 0.5·(d + d'))`.
   > **Impl footnote (2026-05-16, Task 3):** the GPU minimal-state design
   > (state = A:`b,d,s,ocean` + F only; velocity recomputed from `uF` in
   > ERODE/ADVECT with NO pre-water depth channel) makes the exact
   > `0.5·(d+d')` average unavailable in those passes. The implementation
   > uses `l · d'` (post-water depth — the standard single-buffer Mei
   > formulation), applied consistently in ERODE and ADVECT. This is a
   > damping/normalization factor affecting tuning magnitude, not
   > morphology or sign; gated by the Task-8 visual validation. Exact
   > averaging would require adding a pre-water depth channel, which the
   > minimal-state design intentionally forbids.
4. **Erode / deposit** —
   `sinα = max(sinMin, |∇b| / sqrt(1+|∇b|²))` (∇b from wrapped central diff);
   `C = Kc · sinα · |v|`;
   if `C > s`: `m = min(maxDeltaB, Ks·(C−s))`; `b −= m`; `s += m`;
   else: `m = min(maxDeltaB, Kd·(s−C))`; `b += m`; `s −= m`.
   Then land uplift: if not ocean, `b += upliftRate·dt·wLat`.
   Ocean cells: skip erosion (`b` unchanged, `s=0`).
5. **Advect sediment** — semi-Lagrangian: `s_new = bilinear(s, pos − v·dt)`
   with x wrapped, y clamped.
6. **Evaporate** — `d := max(0, d · (1 − Ke·dt))`.
7. **Thermal (optional, every `K` steps)** — if steepest neighbour drop slope
   `> tanTalus`, move `Kt·(b − b_lowestNeighbour)·0.5` toward that neighbour
   (mass-conserving, ocean-skipped). Produces talus/scree.

NaN/clamp guards: `d ≥ 0`, `s ≥ 0`, finite checks; flux-scale guarded against
zero sum; `|∇b|` clamped. The `maxDeltaB` clamp + uplift are the
**macro-preservation** mechanism (replaces frequency-separation): detail is
added while painted continents stay recognizable, no separate blend stage.

Loop runs `N` steps (bake-then-watch; default e.g. 200, tunable) in chunks of
`C` steps with a macrotask yield between chunks so the webview stays alive
(reuse the established yield pattern; the raw runner never touches three so
this is purely JS-loop chunking).

## Components / files

- **Rust** `src-tauri/src/bake_equirect.rs` — `#[tauri::command]
  bake_inputs_equirect(draft, w, h) -> EquirectInputs { w, h, height: Vec<f32>,
  precip: Vec<f32> }`. For each texel → (lat,lon) per the fixed convention →
  unit sphere position → nearest painted Goldberg cell (reuse the existing
  draft→cells path) → `height` = that cell's elevation; `precip` = that cell's
  climate precipitation (climate computed before sampling). Register in
  `lib.rs`; remove the `erosion` module + `bake_erode_v2`/`bake_h0_v2`.
- **TS** `src/viewport/bake/hydraulic.glsl.ts` — the ≤7 fragment shaders
  (rain, flux, water+vel, erode/deposit, advect, evaporate, thermal) as plain
  GLSL strings, array-join, **zero backticks**, self-contained GLSL ES 3.00
  matching `glPass.ts` program conventions (own `precision` + `out vec4
  fragColor`).
- **TS** `src/viewport/bake/hydraulic.ts` — `runHydraulicBake(renderer, base,
  precip, cfg, onProgress?) -> THREE.WebGLRenderTarget` (eroded equirect; `A.r`
  in `.r`). Allocates RTs (via the reduced `pingpong.ts` helper), seeds `A`/`F`,
  runs the step loop via `glPass.runRawPass`, single end `resetState()`,
  returns the RT.
- **TS** `src/viewport/bake/equirectInput.ts` — `uploadEquirect(arr, w, h) ->
  THREE.DataTexture` (single-channel RGBA32F, Nearest, ClampToEdge, no flipY).
- **TS modify** `App.tsx` `handleDebugBake` — rewire to:
  `invoke("bake_inputs_equirect", {draft, w, h})` → `uploadEquirect` ×2 →
  `scene.runBake(r => runHydraulicBake(r, base, precip, cfg, onProgress))` →
  `setGlobe(debug relief mesh)`; keep the `h0`/eroded toggle (bind `Base` as
  the "no-erosion" view, eroded `A.r` as the eroded view). Remove the parity
  button.
- **TS modify** `pingpong.ts` — reduce to float-probe + RT alloc; delete the
  rest (per Scope).
- **KEEP unchanged** `glPass.ts`, `debugMaterial.ts`.

## Error handling

- `decideFloatSupport` hard-fails with a clear error if
  `EXT_color_buffer_float` is absent (RGBA32F RTs impossible) — kept.
- `OES_texture_float_linear` absent ⇒ Nearest filtering + the GLSL already
  samples by explicit texel math (no hardware bilinear required except the
  sediment advection, which does an explicit 4-tap bilinear in-shader).
- Shader compile/link failure throws naming the pass (glPass already does).
- Rust command failure surfaced via the existing error path in App.tsx.
- In-shader: clamp `d≥0`, `s≥0`, guard zero divisions, finite-guard outputs.
- Pole damping prevents projection blow-up at high latitude.

## Testing

- **Rust unit test** for `bake_inputs_equirect`: a synthetic draft with one
  painted continent → assert land texels (`height>0`) occur where painted and
  ocean (`height<0`) elsewhere; `precip` finite and in range; dimensions match
  `w,h`; pole rows present.
- **TS standalone tests** (`npx tsx`, `node:assert`, no headless GL — same
  constraint as before): `hydraulic.glsl.ts` contains zero backticks and each
  shader string is non-empty / well-formed; `hydraulic.ts` pure scheduling
  logic (step/chunk count, uniform object assembly) is correct; `equirectInput`
  produces a DataTexture of the right dimensions/format.
- **Visual validation is the real gate** (per the standing project rule —
  validate sim features visually, not by metric counts; no parity harness):
  bake (a) the Earth-DEM template and (b) a hand-painted continent, then eyeball
  with the eroded/no-erosion toggle:
  - dendritic incised valleys + sharp ridgelines + deposition fans appear in
    the eroded view and are absent in the no-erosion view;
  - painted continents / macro silhouette remain recognizable (macro-preserved);
  - ocean renders blue (`b<0` preserved on ocean cells);
  - the ±180° longitude seam is continuous (no visible meridian);
  - poles are clean (no blow-up / NaN ring);
  - climate coupling reads: wetter regions (per precip) show visibly stronger
    incision than arid ones.

## Success criteria

- Bake completes in seconds at debug resolution with **zero** WebGL errors
  (raw runner already proven; this design adds no three-renderer per-pass use).
- The eroded equirect visibly exhibits the Q4 morphology (sharp dendritic
  incision, ridgelines, fans) that the no-erosion toggle lacks, **with the
  painted continents preserved**.
- Ocean stays `b<0` (blue); seam continuous; poles clean; no NaNs.
- Precip coupling visibly differentiates wet vs arid erosion.
- No cube-sphere, no graph, no flow-accumulation, no CPU oracle, no parity
  harness — the entire failure-prone surface is gone.

## Out of scope (explicit)

- Lighting / colour / atmosphere / material shading (the `dtfXWB` *rendering*
  appeal) — a separate renderer (Subsystem D) follow-up.
- High-resolution / performance tuning beyond "completes in seconds at debug
  res" — a later pass if needed.
- Re-coupling erosion back into climate/biomes (one-directional
  climate→erosion only for now).
