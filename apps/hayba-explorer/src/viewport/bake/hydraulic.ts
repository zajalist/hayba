// Virtual-pipes shallow-water hydraulic erosion ORCHESTRATOR (Mei et al.
// 2007) on a single equirectangular grid.
//
// AUTHORITATIVE DESIGN: docs/superpowers/specs/2026-05-16-erosion-rework-
// hydraulic-design.md  ->  "Data flow", "The simulation step", "State &
// input textures", "Components".
//
// WHAT THIS FILE DOES
// -------------------
// Allocates the ping-pong RGBA32F state (A: b,d,s,ocean ; F: fL,fR,fB,fT)
// + the two static input DataTextures (Base.r height, Precip.r precip),
// seeds A/F, then runs `cfg.steps` simulation steps. Every fragment pass
// is issued through `glPass.runRawPass` (its own FBO + explicit post-draw
// sampler/FBO unbind — a read==write feedback loop is structurally
// impossible). Three's renderer is NEVER touched per-pass; a single
// `renderer.resetState()` after the loop resyncs three's GL-state cache
// before the app's render loop resumes (it samples the returned RT).
//
// PING-PONG DISCIPLINE (the load-bearing invariant)
// -------------------------------------------------
// `A` and `F` each own TWO RGBA32F render targets. For every writing pass:
// it SAMPLES the channel's current `read` RT and DRAWS into the channel's
// `write` RT (always a different object), then we swap that channel's
// read/write so the just-written RT becomes the next read. A pass never
// samples the RT it draws into. Channel ownership per pass:
//   RAIN   reads A      -> writes A   (swap A)
//   FLUX   reads A,F     -> writes F   (swap F)   <-- only F-writing pass
//   WATER  reads A,F     -> writes A   (swap A)
//   ERODE  reads A,F     -> writes A   (swap A)
//   ADVECT reads A,F     -> writes A   (swap A)
//   EVAP   reads A      -> writes A   (swap A)
//   THERMAL reads A      -> writes A   (swap A)   every cfg.thermalEvery
// F is only written by FLUX (every step); A is written by every other
// pass. Each pass's uniforms object provides EXACTLY the names that frag
// declares (glPass parses `uniform <type> <name>;` from the frag itself
// and dispatches by parsed type — a missing/mis-typed uniform silently
// corrupts the bake, so the per-pass sets below are matched 1:1 to
// hydraulic.glsl.ts).

import * as THREE from "three";
import {
  RAIN_FRAG,
  FLUX_FRAG,
  WATER_FRAG,
  CARVE_RIVERS_FRAG,
  ERODE_FRAG,
  ADVECT_FRAG,
  EVAP_FRAG,
  THERMAL_FRAG,
  DETAIL_MASK_FRAG,
  INIT_ACC_FRAG,
  ACCUM_FRAG,
  CONTROLS_FRAG,
  CLIMATE_FRAG,
  TERRAIN_FRAG,
  HYDRO_FRAG,
  WIND_FRAG,
  MSLP_FRAG,
  BLUR_H_FRAG,
  BLUR_V_FRAG,
} from "./hydraulic.glsl";
import { runRawPass } from "./glPass";
import { createPingPong, type PingPongTargets } from "./pingpong";

/** Tunable simulation parameters. The pinned numeric defaults live in
 *  `DEFAULT_HYDRAULIC`; the GL path consumes these as float uniforms. */
export interface HydraulicConfig {
  /** Total simulation steps (bake-then-watch; tunable). */
  steps: number;
  /** Steps per chunk between macrotask yields (webview stays alive). */
  chunk: number;
  /** Time step. */
  dt: number;
  /** Rain deposited per step = dt*rainScale*precip*wLat. */
  rainScale: number;
  /** Gravity g (flux acceleration). */
  gravity: number;
  /** Virtual-pipe cross-section area Ap. */
  pipeArea: number;
  /** Grid cell length l (= 1 grid unit). */
  cellL: number;
  /** Sediment capacity coefficient Kc. */
  kc: number;
  /** Erosion (dissolve) rate Ks. */
  ks: number;
  /** Deposition rate Kd. */
  kd: number;
  /** Evaporation rate Ke. */
  ke: number;
  /** Minimum tilt sinα floor (keeps flats slowly carving). */
  sinMin: number;
  /** Erosion/thermal rate (dimensionless, integrated over `steps`).
   *  Drives incision against the true metre slope (Gaea §10) — replaces
   *  the old per-step `maxDeltaB` clamp + `uplift` mechanism. */
  strength: number;
  /** Vertical incision rate against the true metre slope. */
  downcutting: number;
  /** S2.2 anisotropic thermal/talus transport rate (was Kt). */
  thermalStrength: number;
  /** Talus angle of repose, DEGREES (tan() taken in TS at the call site). */
  talusAngle: number;
  /** Talus direction-bias 0..1 (0 = isotropic, 1 = max striation/ridging). */
  anisotropy: number;
  /** Fraction of slid material lost to suspension, 0..1. */
  sedimentRemoval: number;
  /** S2.4 detailMask elevation gate, normalised-height fractions: mask
   *  rises from `elevFloor`*V to `elevMid`*V metres (V = verticality). */
  elevFloor: number;
  elevMid: number;
  /** S2.4 detailMask slope gate, TRUE metre slope: mask rises from
   *  `slopeFloor` to `slopeMid`. Tuned to the macro-bake slope regime
   *  (planet terrainScale ⇒ small metre slopes); S3 tiles revisit. */
  slopeFloor: number;
  slopeMid: number;
  /** #218 flow-accumulation drainage. `accumIters` (K) MFD gather
   *  iterations per refresh; refresh runs every `accumEveryN` sim steps
   *  (co-evolution). `mfdExponent` (p) sharpens the slope-weighted split.
   *  Incision = `streamK · Q^spM · S^spN` (Q = accumulation discharge,
   *  S = true metre slope). `accMin` = per-cell runoff floor.
   *  `accResScale` = (W/REF)^q resolution-normalisation of Q (measured
   *  via the oracle, NOT assumed — set later). */
  accumIters: number;
  accumEveryN: number;
  mfdExponent: number;
  streamK: number;
  spM: number;
  spN: number;
  accMin: number;
  accResScale: number;
  /** R1a: per-step incision budget on concave valley cells =
   *  1e-3 + channelDepth·concave·Q^spM, so high-discharge channels cut
   *  deep while interfluves stay (channel/ridge contrast). Convex/rim
   *  cells keep the 1e-3 floor (anti-moat). */
  channelDepth: number;
  /** R1b: deterministic jitter added to the single-flow steepest-descent
   *  metric to break exact ties / D8 axis-locking (0 = pure D8). */
  sfdJitter: number;
  /** #226 Phase-A multi-pattern drainage. Per-operator routing-bias
   *  strengths (0 ⇒ that operator off; ALL 0 ⇒ byte-identical to the
   *  #218 SFD baseline — the degradation gate). `uniformityThreshold`
   *  = min slope-coherence for the parallel operator; `curvatureScale`
   *  = normaliser for the peak/basin signal; `ctrlRadius` = control
   *  box half-width in texels; `endorheicSteps` = max sdir hops for
   *  closed-basin detection; `patternMax` (<1) caps the summed
   *  non-dendritic weight so dendritic always has a floor. */
  radialStrength: number;
  parallelStrength: number;
  centripetalStrength: number;
  uniformityThreshold: number;
  curvatureScale: number;
  ctrlRadius: number;
  endorheicSteps: number;
  patternMax: number;
  /** #234 P2.2 analytic climate (climate.rs reference values).
   *  Temperature = tEquatorC − tLatDropC·sin²lat − lapseCPerKm·elevKm
   *  (elevKm = max(0,h)·elevKmScale). Zonal precip ITCZ half-width
   *  itczWidthDeg. Glaciation ramps 0→1 as T falls glacOnsetC→glacFullC
   *  (long-term ice; NOT seasonal snow). */
  tEquatorC: number;
  tLatDropC: number;
  lapseCPerKm: number;
  elevKmScale: number;
  itczWidthDeg: number;
  glacOnsetC: number;
  glacFullC: number;
  /** NX-2a geostrophic-wind knobs (MdGBWG annual-mean MSLP). */
  mslpLandBase: number;
  mslpLandAmp: number;
  mslpOceanBase: number;
  mslpOceanAmp: number;
  mslpBlurSigma: number;
  coriolisGain: number;
  /** NX-2c MdGBWG seasonality. `seasonAmp` master-scales the Jan/July
   *  MSLP delta (0 = annual mean = deep-time freeze; the tectonics sim
   *  bakes at 0 — seasons are meaningless over Myr). `seasonPhase` is
   *  the simulated month in [0,12) (0=Jan, 6=Jul); inert while amp 0. */
  seasonAmp: number;
  seasonPhase: number;
  /** P2.2-oro orographic precipitation. `orographicGain` multiplies the
   *  windward (upslope, wind·∇h>0) precip boost; `rainShadow` multiplies
   *  the leeward (downslope, wind·∇h<0) precip cut. Both clamped to keep
   *  P in [0.05, 1.0]. Defaults mirror climate.rs ClimateParams. */
  orographicGain: number;
  rainShadow: number;
  /** CLIM-MONSOON onshore moisture transport (cookbook principle:
   *  "summer low pulls moisture-laden air from ocean"). Scales the
   *  ADDITIVE precip boost driven by upwind ocean fraction (4 samples
   *  along wind direction). 0.0 = off (no moisture transport); 0.5 =
   *  monsoon coasts can override the subtropical-dry zonal band. */
  onshoreGain: number;
  /** P2.3b-i Whittaker biome thermal cuts (°C) — mirrors
   *  ClimateParams.biome_cold_c / biome_hot_c. */
  biomeColdC: number;
  biomeHotC: number;
  /** S2.3 concavity gate: river carve is multiplied by
   *  `smoothstep(0, concaveScale, laplacian(b))` so incision only bites
   *  CONCAVE valley floors, not CONVEX plateau/range shoulders (kills the
   *  escarpment "moat" around Tibet/Andes). Laplacian is in normalised
   *  height units; smaller ⇒ valleys reach full carve sooner. */
  concaveScale: number;
  /** Run THERMAL when step % thermalEvery === 0 (<=0 disables it). */
  thermalEvery: number;
  /** Polar-cap damp fraction (rain/erosion -> 0 within this band). */
  poleBand: number;
  /** Metre-denominated world scale (Gaea §10). Mirrors the Rust
   *  `WorldScale` (camelCase here, snake_case on the wire); the App.tsx
   *  call site maps `EquirectInputs.scale` into this. Planet macro
   *  default; S3 overrides per zoom-tile. */
  scale: { terrainScale: number; verticality: number; featureScale: number };
}

/** Pinned numeric defaults (authoritative — plan Task 4).
 *
 * S1 METRE-DENOMINATED MODEL (2026-05-16). The old per-step `maxDeltaB`
 * incision clamp + land `uplift` are removed. Erosion strength is now
 * physical: ERODE computes the true metre slope `slope = Δh*verticality /
 * (terrainScale/resolution)` and drives incision by `strength`/
 * `downcutting` integrated by `dt` over `steps`. Macro preservation in S1
 * is interim — gentle metre-scale physics + the ocean early-return (ERODE
 * skips `base.r < 0` cells, pole-damped) — until S2's Laplacian band split
 * takes over silhouette preservation. `strength` is small ("not way too
 * strong") and is the tunable the controller's visual gate adjusts. */
export const DEFAULT_HYDRAULIC: HydraulicConfig = {
  steps: 100,
  chunk: 16,
  dt: 0.02,
  rainScale: 0.012,
  gravity: 9.81,
  pipeArea: 1.0,
  cellL: 1.0,
  kc: 0.18,
  ks: 0.3,
  kd: 0.2,
  ke: 0.015,
  sinMin: 0.02,
  strength: 0.06,
  downcutting: 0.25,
  // S2.2 thermal = GENTLE TALUS LIMITER, PHYSICALLY GROUNDED (corrected
  // 2026-05-17 per user: "base it on real science, not no-unit").
  // talusAngle is now the REAL dry-rock/scree ANGLE OF REPOSE — 33°
  // (geology: cohesionless coarse debris reposes at ~30–37°; 33° is a
  // standard mid value). It is compared (as tan 33° ≈ 0.649) against the
  // TRUE metre slope Δ(h·verticality)/(terrainScale/W) — S1-consistent,
  // dimensionally honest. Physical consequence at the PLANET macro bake:
  // one texel ≈ 20 km, so a 33° talus face is far sub-pixel and the test
  // rarely fires — which is *correct*: you don't see scree slopes from
  // orbit. So macro relief is shaped by ERODE + S2.3 river incision;
  // thermal is only a faint anisotropic limiter on the steepest resolved
  // macro slopes (strength low). On S3 zoom-tiles (small terrainScale ⇒
  // metres-per-texel small) the same real 33° becomes fully meaningful.
  // The CFL net-clamp keeps it unconditionally stable regardless.
  thermalStrength: 0.05,
  talusAngle: 33,
  anisotropy: 0.5,
  sedimentRemoval: 0.0,
  // S2.4 detail-mask gates (macro-slope regime; see HydraulicConfig).
  elevFloor: 0.15,
  // slopeMid lowered so the detailMask SATURATES at gentle mountain
  // slopes — moderate ranges (Afghanistan) get FULL incision, not a
  // throttled fraction (was a hidden cause of "ridges too faint").
  elevMid: 0.4,
  slopeFloor: 0.0003,
  slopeMid: 0.001,
  // #218 R1: provisional — set from the oracle gate. SFD (single-flow)
  // accumulation so K is the headwater→mouth propagation length: large
  // (warm 2M bake ~0.5s leaves headroom). accResScale=1 (measured
  // resolution-invariant, no W-scaling needed). channelDepth/sfdJitter
  // are the R1 dendritic knobs (tuned at the gate).
  accumIters: 256,
  accumEveryN: 16,
  mfdExponent: 1.3,
  streamK: 0.02,
  spM: 0.9,
  spN: 1.0,
  accMin: 0.05,
  accResScale: 1.0,
  // #226: gentle nonzero so patterns read while dendritic stays
  // dominant; oracle-tuned in the gate task. All-zero override is the
  // degradation regression gate (≡ #218 8ecba5b).
  radialStrength: 0.15,
  parallelStrength: 0.15,
  centripetalStrength: 0.15,
  uniformityThreshold: 0.55,
  curvatureScale: 0.02,
  ctrlRadius: 3,
  endorheicSteps: 64,
  patternMax: 0.75,
  // #234 P2.2 — climate.rs defaults; glac isotherm −2→−12 °C (LGM-ish).
  tEquatorC: 30.0,
  tLatDropC: 50.0,
  lapseCPerKm: 4.46,
  elevKmScale: 8.0,
  itczWidthDeg: 22.0,
  glacOnsetC: -2.0,
  glacFullC: -12.0,
  mslpLandBase: 1012.5,
  mslpLandAmp: 6.0,
  mslpOceanBase: 1014.5,
  mslpOceanAmp: 20.0,
  mslpBlurSigma: 6.0,
  coriolisGain: 15.0,
  // CLIM-MONSOON: seasonality enabled by default so continental
  // summer-low / oceanic-summer-high pressure swap can drive monsoon
  // winds. seasonPhase=6.0 picks the NH summer (July) snapshot, peak
  // Asian monsoon. This is the cookbook's "summer pressure" picture.
  seasonAmp: 0.5,
  seasonPhase: 6.0,
  orographicGain: 0.6,
  rainShadow: 0.5,
  onshoreGain: 0.5,
  biomeColdC: 6.0,
  biomeHotC: 18.0,
  channelDepth: 0.02,
  sfdJitter: 0.002,
  // Concave valleys reach full carve by lap≈0.003; every convex shoulder
  // (lap≤0) gets exactly 0 → the Tibet/Andes rim moat is removed while
  // the concave dendritic valleys (Afghanistan) keep their strong carve.
  concaveScale: 0.003,
  thermalEvery: 20,
  poleBand: 0.04,
  scale: {
    terrainScale: 2 * Math.PI * 6371000,
    verticality: 9000,
    featureScale: 2000,
  },
};

/**
 * Pure, deterministic step scheduling.
 *
 * Splits `cfg.steps` into consecutive chunks of `cfg.chunk` with the final
 * chunk holding the remainder. Invariants (asserted by the unit test):
 *   - sum(chunks) === cfg.steps === totalSteps
 *   - every chunk > 0 and <= cfg.chunk
 * No GL — this is the only headless-testable surface (the bake's GPU
 * correctness is the user's Task-8 visual gate).
 */
export function planSteps(cfg: HydraulicConfig): {
  totalSteps: number;
  chunks: number[];
} {
  const total = Math.max(0, Math.floor(cfg.steps));
  const chunk = Math.max(1, Math.floor(cfg.chunk));
  const chunks: number[] = [];
  let left = total;
  while (left > 0) {
    const c = Math.min(chunk, left);
    chunks.push(c);
    left -= c;
  }
  return { totalSteps: total, chunks };
}

/** Park the microtask chain on a macrotask so the browser event loop runs
 *  (same established pattern as the prior bake code). */
const yieldToLoop = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

// Minimal inline SEED frag — glPass-contract-clean: own precision +
// `out vec4 fragColor;`, ONE uniform per line, no comment on any
// uniform-decl line, GLSL ES 3.00 (texelFetch), zero backticks. Samples
// uBase.r and writes the A layout per the spec:
//   r = b = base.r , g = d = 0 , b = s = 0 , a = ocean = base.r<0 ? 1 : 0
// Row 0 = North (DataTextures uploaded flipY=false) so the framebuffer
// row index == the data row index: rc = ivec2(gl_FragCoord.xy).
const SEED_A_FRAG = [
  "precision highp float;",
  "precision highp int;",
  "out vec4 fragColor;",
  "uniform sampler2D uBase;",
  "void main(){",
  "  ivec2 rc = ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y));",
  "  float b = texelFetch(uBase, rc, 0).r;",
  "  float ocean = b < 0.0 ? 1.0 : 0.0;",
  "  fragColor = vec4(b, 0.0, 0.0, ocean);",
  "}",
].join("\n");

// Minimal inline SEED frag for F — all flux channels start at 0.
const SEED_F_FRAG = [
  "precision highp float;",
  "precision highp int;",
  "out vec4 fragColor;",
  "void main(){",
  "  fragColor = vec4(0.0);",
  "}",
].join("\n");

/** uniform-name -> IUniform wrapper (glPass reads `.value`). */
type U = Record<string, THREE.IUniform>;
const u = (value: unknown): THREE.IUniform => ({ value });

/**
 * Run the full hydraulic bake and return the RGBA32F render target that
 * currently holds the eroded state `A` (eroded equirect terrain in `.r`,
 * `ocean` in `.a`). The caller owns the returned RT and disposes it
 * (FBO + texture) when done; every other transient RT is disposed here.
 *
 * `base`/`precip` are single-channel-in-`.r` RGBA32F DataTextures
 * (equirectInput.uploadEquirect), Nearest/clamp/flipY=false. `w`/`h` are
 * the equirect grid dims (must equal the DataTexture dims).
 *
 * Float support is hard-guarded by `createPingPong` (it throws if
 * `EXT_color_buffer_float` is absent — RGBA32F RTs impossible).
 */
/**
 * What {@link runHydraulicBake} hands back. `eroded` is today's owned
 * result (A's current read slot). `clim/terr/hydro` are the CLIM/TERR/
 * HYDRO[0] stack slots — they used to be disposed at teardown; now
 * ownership transfers to the caller, which disposes all four exactly as
 * it already tracks/disposes the previous eroded RT. Read-only: nothing
 * feeds them back into the sim (the Phase-2 #218 degradation contract).
 */
export interface HydraulicBakeResult {
  eroded: THREE.WebGLRenderTarget;
  clim: THREE.WebGLRenderTarget;
  terr: THREE.WebGLRenderTarget;
  hydro: THREE.WebGLRenderTarget;
  wind: THREE.WebGLRenderTarget;
}

export async function runHydraulicBake(
  renderer: THREE.WebGLRenderer,
  base: THREE.DataTexture,
  precip: THREE.DataTexture,
  w: number,
  h: number,
  cfg: HydraulicConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<HydraulicBakeResult> {
  // A and F each get a pair of RGBA32F RTs. createPingPong is the reused
  // float-probe + RGBA32F allocation helper (pingpong.ts:448) — it HARD
  // FAILS if EXT_color_buffer_float is missing. We drive the read/write
  // slots explicitly below (NOT pp.book) so the discipline is local and
  // unambiguous.
  const pp: PingPongTargets = createPingPong(renderer, w, h, ["A", "F", "M", "ACC", "CTRL", "CLIM", "TERR", "HYDRO", "MSLP", "WIND"]);
  const A = pp.rt.A; // [slot0, slot1]
  const F = pp.rt.F; // [slot0, slot1]
  // S2.4 detail mask: a ONE-TIME single-channel field (computed pre-loop
  // from the seeded base, then read-only). Only M[0] is used (no swap);
  // M[1] is allocated by the pair helper and just disposed at teardown.
  const M = pp.rt.M;

  // #218 drainage accumulation (discharge in .r). Ping-pong like A: the
  // refresh burst writes it; CARVE reads it. Both slots freed at teardown.
  const ACC = pp.rt.ACC;
  // #226 control channels (slope-azimuth/uniformity/curvature/endorheic).
  // Single-buffered: CONTROLS writes CTRL[0], ACCUM reads it; CTRL[1]
  // is allocated by the pair helper and just disposed at teardown.
  const CTRL = pp.rt.CTRL;
  // #234 P2.1 unified climate/mask stack (scaffold). CLIM/TERR/HYDRO
  // are the named substrate P2.2+ fills; P2.1 zero-fills them and
  // NOTHING consumes them, so erosion is provably unchanged (the
  // Phase-2 degradation contract).
  const CLIM = pp.rt.CLIM;
  const TERR = pp.rt.TERR;
  const HYDRO = pp.rt.HYDRO;
  // NX-2a climate-internal scratch: allocated once per bake with every
  // other channel (no per-tick alloc), reused every refreshClimate
  // tick, disposed once at teardown; never escapes, never feeds erosion.
  const MSLP = pp.rt.MSLP;
  const WIND = pp.rt.WIND;
  let accRead = 0;
  const swapAcc = (): void => {
    accRead ^= 1;
  };
  const accReadRT = (): THREE.WebGLRenderTarget => ACC[accRead];
  const accWriteRT = (): THREE.WebGLRenderTarget => ACC[accRead ^ 1];

  // Per-channel current read index (0|1); write is always the OPPOSITE
  // slot, so a pass never samples the RT it draws into. swap*() flips the
  // index AFTER the pass has written, making the just-written RT the next
  // read.
  let aRead = 0;
  let fRead = 0;
  const swapA = (): void => {
    aRead ^= 1;
  };
  const swapF = (): void => {
    fRead ^= 1;
  };
  const aReadRT = (): THREE.WebGLRenderTarget => A[aRead];
  const aWriteRT = (): THREE.WebGLRenderTarget => A[aRead ^ 1];
  const fReadRT = (): THREE.WebGLRenderTarget => F[fRead];
  const fWriteRT = (): THREE.WebGLRenderTarget => F[fRead ^ 1];

  const uGrid = new THREE.Vector2(w, h);

  const refreshClimate = (): void => {
    runRawPass(
      renderer,
      MSLP_FRAG,
      {
        uA: u(aReadRT()),
        uGrid: u(uGrid),
        uMslpLandBase: u(cfg.mslpLandBase),
        uMslpLandAmp: u(cfg.mslpLandAmp),
        uMslpOceanBase: u(cfg.mslpOceanBase),
        uMslpOceanAmp: u(cfg.mslpOceanAmp),
        uSeasonAmp: u(cfg.seasonAmp),
        uSeasonPhase: u(cfg.seasonPhase),
      },
      MSLP[0],
    );
    runRawPass(
      renderer,
      BLUR_H_FRAG,
      { uMSLP: u(MSLP[0]), uGrid: u(uGrid), uBlurSigma: u(cfg.mslpBlurSigma) },
      MSLP[1],
    );
    runRawPass(
      renderer,
      BLUR_V_FRAG,
      { uMSLP: u(MSLP[1]), uGrid: u(uGrid), uBlurSigma: u(cfg.mslpBlurSigma) },
      MSLP[0],
    );
    runRawPass(
      renderer,
      CLIMATE_FRAG,
      {
        uA: u(aReadRT()),
        uGrid: u(uGrid),
        uMSLP: u(MSLP[0]),
        uCoriolisGain: u(cfg.coriolisGain),
        uTEquatorC: u(cfg.tEquatorC),
        uTLatDropC: u(cfg.tLatDropC),
        uLapseCPerKm: u(cfg.lapseCPerKm),
        uElevKmScale: u(cfg.elevKmScale),
        uItczWidthDeg: u(cfg.itczWidthDeg),
        uGlacOnsetC: u(cfg.glacOnsetC),
        uGlacFullC: u(cfg.glacFullC),
        uOrographicGain: u(cfg.orographicGain),
        uRainShadow: u(cfg.rainShadow),
        uOnshoreGain: u(cfg.onshoreGain),
      },
      CLIM[0],
    );
    runRawPass(
      renderer,
      WIND_FRAG,
      {
        uMSLP: u(MSLP[0]),
        uGrid: u(uGrid),
        uCoriolisGain: u(cfg.coriolisGain),
      },
      WIND[0],
    );
    runRawPass(
      renderer,
      TERRAIN_FRAG,
      {
        uA: u(aReadRT()),
        uCtrl: u(CTRL[0]),
        uGrid: u(uGrid),
        uVerticality: u(cfg.scale.verticality),
        uTerrainScale: u(cfg.scale.terrainScale),
        uSinMin: u(cfg.sinMin),
      },
      TERR[0],
    );
    runRawPass(
      renderer,
      HYDRO_FRAG,
      {
        uA: u(aReadRT()),
        uAcc: u(accReadRT()),
        uCtrl: u(CTRL[0]),
        uClim: u(CLIM[0]),
        uGrid: u(uGrid),
        uBiomeColdC: u(cfg.biomeColdC),
        uBiomeHotC: u(cfg.biomeHotC),
      },
      HYDRO[0],
    );
  };

  // Resolution invariance (measured, not assumed). S1 made `slope`
  // W-invariant, but virtual-pipe flux ∝ per-texel Δ(b+d) so every
  // flux-derived erosion term (ERODE capacity via vmag; CARVE_RIVERS river
  // mask via flowMag) weakens with W. An apples-to-apples study (same
  // continuous field at 256/512/1024, oracle) measured interior |Δ| =
  // 0.0408 / 0.0247 / 0.0118 ⇒ erosion ∝ W^-0.89. resScale = (W/REF)^0.89
  // exactly cancels that so the SAME physical erosion happens at any W
  // (the flux-side counterpart of S1's metre-slope fix). REF = the
  // debug/oracle resolution the strength knobs are calibrated at; at
  // W=REF resScale=1 (unchanged).
  const EROSION_REF_W = 256;
  const resScale = Math.pow(w / EROSION_REF_W, 0.89);

  // ---- SEED: A := (base.r, 0, 0, base.r<0?1:0) ; F := 0 ----------------
  // Seed writes into the READ slot of each channel (A[0]/F[0]) so the
  // first step's RAIN/FLUX read the seeded state.
  runRawPass(renderer, SEED_A_FRAG, { uBase: u(base) }, aReadRT());
  runRawPass(renderer, SEED_F_FRAG, {}, fReadRT());

  // ---- S2.4 DETAIL MASK (ONE-TIME): from the seeded base height, write
  // M[0] = elevGate*slopeGate (ocean -> 0). Read every step by ERODE
  // (gates incision) and THERMAL (gates net move) so high-freq detail is
  // concentrated on steep/high terrain and spared on ocean & flatland.
  runRawPass(
    renderer,
    DETAIL_MASK_FRAG,
    {
      uA: u(aReadRT()),
      uGrid: u(uGrid),
      uVerticality: u(cfg.scale.verticality),
      uTerrainScale: u(cfg.scale.terrainScale),
      uElevFloor: u(cfg.elevFloor),
      uElevMid: u(cfg.elevMid),
      uSlopeFloor: u(cfg.slopeFloor),
      uSlopeMid: u(cfg.slopeMid),
    },
    M[0],
  );

  // #218 accumulation refresh: INIT_ACC then K MFD-gather iterations,
  // reading the CURRENT A (co-evolution). Leaves the converged field in
  // accReadRT(). Called once pre-loop (seed) and every accumEveryN steps.
  const refreshAccumulation = (): void => {
    runRawPass(
      renderer,
      CONTROLS_FRAG,
      {
        uA: u(aReadRT()),
        uGrid: u(uGrid),
        uCtrlRadius: u(cfg.ctrlRadius),
        uEndorheicSteps: u(cfg.endorheicSteps),
        uCurvatureScale: u(cfg.curvatureScale),
      },
      CTRL[0],
    );
    runRawPass(
      renderer,
      INIT_ACC_FRAG,
      {
        uA: u(aReadRT()),
        uPrecip: u(precip),
        uGrid: u(uGrid),
        uPoleBand: u(cfg.poleBand),
        uAccMin: u(cfg.accMin),
      },
      accReadRT(),
    );
    const K = Math.max(1, Math.floor(cfg.accumIters));
    for (let k = 0; k < K; k++) {
      runRawPass(
        renderer,
        ACCUM_FRAG,
        {
          uA: u(aReadRT()),
          uAcc: u(accReadRT()),
          uPrecip: u(precip),
          uGrid: u(uGrid),
          uSfdJitter: u(cfg.sfdJitter),
          uPoleBand: u(cfg.poleBand),
          uAccMin: u(cfg.accMin),
          uCtrl: u(CTRL[0]),
          uRadialStrength: u(cfg.radialStrength),
          uParallelStrength: u(cfg.parallelStrength),
          uCentripetalStrength: u(cfg.centripetalStrength),
          uUniformityThreshold: u(cfg.uniformityThreshold),
          uCurvatureScale: u(cfg.curvatureScale),
          uPatternMax: u(cfg.patternMax),
        },
        accWriteRT(),
      );
      swapAcc();
    }
  };
  refreshAccumulation();
  refreshClimate();

  // ---- One simulation step: the fixed pass order. ---------------------
  // Each pass's uniforms object lists EXACTLY the uniforms that frag
  // declares in hydraulic.glsl.ts (verified 1:1 — see the per-pass
  // comments). glPass dispatches by the GLSL type it parses from the frag
  // (vec2<-Vector2, sampler2D<-Texture/RT, float<-number).
  const step = (doThermal: boolean, stepIdx: number): void => {
    // RAIN: declares uA,uPrecip,uGrid,uDt,uRainScale,uPoleBand.
    // reads A,Precip -> writes A.
    runRawPass(
      renderer,
      RAIN_FRAG,
      {
        uA: u(aReadRT()),
        uPrecip: u(precip),
        uGrid: u(uGrid),
        uDt: u(cfg.dt),
        uRainScale: u(cfg.rainScale),
        uPoleBand: u(cfg.poleBand),
      },
      aWriteRT(),
    );
    swapA();

    // FLUX: declares uA,uF,uGrid,uDt,uGravity,uPipeArea,uCellL.
    // reads A,F -> writes F (the ONLY F-writing pass).
    runRawPass(
      renderer,
      FLUX_FRAG,
      {
        uA: u(aReadRT()),
        uF: u(fReadRT()),
        uGrid: u(uGrid),
        uDt: u(cfg.dt),
        uGravity: u(cfg.gravity),
        uPipeArea: u(cfg.pipeArea),
        uCellL: u(cfg.cellL),
      },
      fWriteRT(),
    );
    swapF();

    // WATER: declares uA,uF,uGrid,uDt,uCellL. reads A,F -> writes A.
    runRawPass(
      renderer,
      WATER_FRAG,
      {
        uA: u(aReadRT()),
        uF: u(fReadRT()),
        uGrid: u(uGrid),
        uDt: u(cfg.dt),
        uCellL: u(cfg.cellL),
      },
      aWriteRT(),
    );
    swapA();

    // #218 co-evolution: rebuild the drainage network from the live
    // terrain every accumEveryN steps; CARVE reads the cached ACC
    // between refreshes.
    if (cfg.accumEveryN > 0 && stepIdx % cfg.accumEveryN === 0) {
      refreshAccumulation();
    }
    if (cfg.accumEveryN > 0 && stepIdx % cfg.accumEveryN === 0) {
      refreshClimate();
    }

    // S2.3-> CARVE_RIVERS (#218 R1): stream-power on the drainage
    // accumulation, Q-proportional incision budget. declares uA,uAcc,
    // uDetailMask,uGrid,uDt,uStreamK,uSpM,uSpN,uAccResScale,uVerticality,
    // uTerrainScale,uSinMin,uConcaveScale,uChannelDepth,uPoleBand.
    // reads A,ACC,M -> writes A.
    runRawPass(
      renderer,
      CARVE_RIVERS_FRAG,
      {
        uA: u(aReadRT()),
        uAcc: u(accReadRT()),
        uDetailMask: u(M[0]),
        uGrid: u(uGrid),
        uDt: u(cfg.dt),
        uStreamK: u(cfg.streamK),
        uSpM: u(cfg.spM),
        uSpN: u(cfg.spN),
        uAccResScale: u(cfg.accResScale),
        uVerticality: u(cfg.scale.verticality),
        uTerrainScale: u(cfg.scale.terrainScale),
        uSinMin: u(cfg.sinMin),
        uConcaveScale: u(cfg.concaveScale),
        uChannelDepth: u(cfg.channelDepth),
        uPoleBand: u(cfg.poleBand),
      },
      aWriteRT(),
    );
    swapA();

    // ERODE: declares uA,uF,uGrid,uDt,uCellL,uKd,uSinMin,uStrength,
    // uDowncutting,uVerticality,uTerrainScale,uPoleBand,uResScale,
    // uAcc,uAccResScale,uSpM,uDetailMask. reads A,F,ACC ->
    // writes A. S1: metre-denominated incision (true slope =
    // Δh*uVerticality / (uTerrainScale/uGrid.x)) replaces the old
    // per-step uMaxDeltaB clamp + uUplift; capacity is uStrength-driven
    // and incision uDowncutting-driven (uKc/uKs no longer used here).
    runRawPass(
      renderer,
      ERODE_FRAG,
      {
        uA: u(aReadRT()),
        uF: u(fReadRT()),
        uGrid: u(uGrid),
        uDt: u(cfg.dt),
        uCellL: u(cfg.cellL),
        uKd: u(cfg.kd),
        uSinMin: u(cfg.sinMin),
        uStrength: u(cfg.strength),
        uDowncutting: u(cfg.downcutting),
        uVerticality: u(cfg.scale.verticality),
        uTerrainScale: u(cfg.scale.terrainScale),
        uPoleBand: u(cfg.poleBand),
        uResScale: u(resScale),
        uAcc: u(accReadRT()),
        uAccResScale: u(cfg.accResScale),
        uSpM: u(cfg.spM),
        uDetailMask: u(M[0]),
      },
      aWriteRT(),
    );
    swapA();

    // ADVECT: declares uA,uF,uGrid,uDt,uCellL. reads A,F -> writes A.
    runRawPass(
      renderer,
      ADVECT_FRAG,
      {
        uA: u(aReadRT()),
        uF: u(fReadRT()),
        uGrid: u(uGrid),
        uDt: u(cfg.dt),
        uCellL: u(cfg.cellL),
      },
      aWriteRT(),
    );
    swapA();

    // EVAP: declares uA,uGrid,uDt,uKe. reads A -> writes A.
    runRawPass(
      renderer,
      EVAP_FRAG,
      {
        uA: u(aReadRT()),
        uGrid: u(uGrid),
        uDt: u(cfg.dt),
        uKe: u(cfg.ke),
      },
      aWriteRT(),
    );
    swapA();

    // THERMAL (optional): S2.2 anisotropic metre-scale talus + S2.4
    // detailMask gate. declares uA,uGrid,uStrengthThermal,uTanTalus,
    // uAnisotropy,uSedimentRemoval,uVerticality,uTerrainScale,uPoleBand,
    // uDetailMask. reads A,M -> writes A. Runs only on the scheduled
    // cadence. uTanTalus = tan(talusAngle°) — talusAngle is the REAL
    // rock angle of repose (33°), compared against the true metre slope
    // (S1-consistent, dimensionally honest; see DEFAULT_HYDRAULIC for the
    // macro-scale physical consequence).
    if (doThermal) {
      runRawPass(
        renderer,
        THERMAL_FRAG,
        {
          uA: u(aReadRT()),
          uGrid: u(uGrid),
          uStrengthThermal: u(cfg.thermalStrength),
          uTanTalus: u(Math.tan((cfg.talusAngle * Math.PI) / 180)),
          uAnisotropy: u(cfg.anisotropy),
          uSedimentRemoval: u(cfg.sedimentRemoval),
          uVerticality: u(cfg.scale.verticality),
          uTerrainScale: u(cfg.scale.terrainScale),
          uPoleBand: u(cfg.poleBand),
          uDetailMask: u(M[0]),
        },
        aWriteRT(),
      );
      swapA();
    }
  };

  // ---- Step loop, chunked with a macrotask yield + progress between
  //      chunks (reuse the established yield pattern; the raw runner
  //      never touches three so this is purely JS-loop chunking). ------
  const plan = planSteps(cfg);
  const total = plan.totalSteps;
  let done = 0;
  for (const c of plan.chunks) {
    for (let i = 0; i < c; i++) {
      // Thermal cadence is 1-based so THERMAL fires on steps
      // thermalEvery, 2*thermalEvery, 3*thermalEvery, ... — matching the
      // user's natural "every N steps" count rather than a 0-indexed
      // offset (and so step 0, the freshly-seeded un-eroded state, is
      // never a thermal step). Not a bug; intentional cadence phase.
      const stepIdx = done + i + 1;
      const doThermal =
        cfg.thermalEvery > 0 && stepIdx % cfg.thermalEvery === 0;
      step(doThermal, stepIdx);
    }
    done += c;
    await yieldToLoop();
    onProgress?.(done, total);
  }

  // ---- Resync three's GL-state cache ONCE, after the loop. Every pass
  //      ran on the raw WebGL2 context (glPass.ts) and never went through
  //      three's renderer, so three's JS-side cache (program/textures/
  //      FBO/VAO/viewport) is stale. The app's render loop resumes right
  //      after this and samples the returned RT; one resetState() makes
  //      three re-issue all GL state fresh. This is the ONLY resetState
  //      (NOT per-pass — per-pass resetState is the canvas-clobbering bug
  //      the raw runner eliminates). The raw runner already left every
  //      sampler unit + the FBO unbound, so this is a clean resync only.
  renderer.resetState();

  // ---- Teardown. FOUR RTs escape this function (caller owns + disposes
  //      all four): the eroded state (A's current read slot) plus the
  //      CLIM/TERR/HYDRO[0] stack slots, which the in-app stack map-mode
  //      reads. Dispose every OTHER transient RT (the other A slot, both
  //      F/M/ACC/CTRL slots, and the transient [1] stack slots) — don't
  //      leak, don't dispose any of the four returned ones. -----------
  const result = A[aRead];
  const stale = A[aRead ^ 1];
  stale.dispose();
  F[0].dispose();
  F[1].dispose();
  M[0].dispose();
  M[1].dispose();
  ACC[0].dispose();
  ACC[1].dispose();
  CTRL[0].dispose();
  CTRL[1].dispose();
  CLIM[1].dispose();
  TERR[1].dispose();
  HYDRO[1].dispose();
  MSLP[0].dispose();
  MSLP[1].dispose();
  WIND[1].dispose();
  return { eroded: result, clim: CLIM[0], terr: TERR[0], hydro: HYDRO[0], wind: WIND[0] };
}
