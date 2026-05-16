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
  ERODE_FRAG,
  ADVECT_FRAG,
  EVAP_FRAG,
  THERMAL_FRAG,
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
  /** Land uplift rate (macro-preservation, with maxDeltaB). */
  uplift: number;
  /** Per-step incision/deposition clamp (macro-preservation). */
  maxDeltaB: number;
  /** Thermal (talus) transport rate Kt. */
  kt: number;
  /** Talus slope threshold tan(angle). */
  tanTalus: number;
  /** Run THERMAL when step % thermalEvery === 0 (<=0 disables it). */
  thermalEvery: number;
  /** Polar-cap damp fraction (rain/erosion -> 0 within this band). */
  poleBand: number;
}

/** Pinned numeric defaults (authoritative — plan Task 4). */
export const DEFAULT_HYDRAULIC: HydraulicConfig = {
  steps: 200,
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
  uplift: 0.0008,
  maxDeltaB: 0.01,
  kt: 0.3,
  tanTalus: 0.6,
  thermalEvery: 8,
  poleBand: 0.04,
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
export async function runHydraulicBake(
  renderer: THREE.WebGLRenderer,
  base: THREE.DataTexture,
  precip: THREE.DataTexture,
  w: number,
  h: number,
  cfg: HydraulicConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<THREE.WebGLRenderTarget> {
  // A and F each get a pair of RGBA32F RTs. createPingPong is the reused
  // float-probe + RGBA32F allocation helper (pingpong.ts:448) — it HARD
  // FAILS if EXT_color_buffer_float is missing. We drive the read/write
  // slots explicitly below (NOT pp.book) so the discipline is local and
  // unambiguous.
  const pp: PingPongTargets = createPingPong(renderer, w, h, ["A", "F"]);
  const A = pp.rt.A; // [slot0, slot1]
  const F = pp.rt.F; // [slot0, slot1]

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

  // ---- SEED: A := (base.r, 0, 0, base.r<0?1:0) ; F := 0 ----------------
  // Seed writes into the READ slot of each channel (A[0]/F[0]) so the
  // first step's RAIN/FLUX read the seeded state.
  runRawPass(renderer, SEED_A_FRAG, { uBase: u(base) }, aReadRT());
  runRawPass(renderer, SEED_F_FRAG, {}, fReadRT());

  // ---- One simulation step: the fixed pass order. ---------------------
  // Each pass's uniforms object lists EXACTLY the uniforms that frag
  // declares in hydraulic.glsl.ts (verified 1:1 — see the per-pass
  // comments). glPass dispatches by the GLSL type it parses from the frag
  // (vec2<-Vector2, sampler2D<-Texture/RT, float<-number).
  const step = (doThermal: boolean): void => {
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

    // ERODE: declares uA,uF,uGrid,uDt,uCellL,uKc,uKs,uKd,uSinMin,
    // uUplift,uMaxDeltaB,uPoleBand. reads A,F -> writes A.
    runRawPass(
      renderer,
      ERODE_FRAG,
      {
        uA: u(aReadRT()),
        uF: u(fReadRT()),
        uGrid: u(uGrid),
        uDt: u(cfg.dt),
        uCellL: u(cfg.cellL),
        uKc: u(cfg.kc),
        uKs: u(cfg.ks),
        uKd: u(cfg.kd),
        uSinMin: u(cfg.sinMin),
        uUplift: u(cfg.uplift),
        uMaxDeltaB: u(cfg.maxDeltaB),
        uPoleBand: u(cfg.poleBand),
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

    // THERMAL (optional): declares uA,uGrid,uCellL,uKt,uTanTalus.
    // reads A -> writes A. Runs only on the scheduled cadence.
    if (doThermal) {
      runRawPass(
        renderer,
        THERMAL_FRAG,
        {
          uA: u(aReadRT()),
          uGrid: u(uGrid),
          uCellL: u(cfg.cellL),
          uKt: u(cfg.kt),
          uTanTalus: u(cfg.tanTalus),
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
      // step index is 1-based for the thermal cadence so step 0 does not
      // trivially trigger THERMAL on every disabled-cadence run.
      const stepIdx = done + i + 1;
      const doThermal =
        cfg.thermalEvery > 0 && stepIdx % cfg.thermalEvery === 0;
      step(doThermal);
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

  // ---- Teardown. The eroded state lives in A's current read slot;
  //      return that RT (caller owns + disposes it). Dispose every other
  //      transient RT (the other A slot + both F slots) — don't leak,
  //      don't dispose the returned one. -------------------------------
  const result = A[aRead];
  const stale = A[aRead ^ 1];
  stale.dispose();
  F[0].dispose();
  F[1].dispose();
  return result;
}
