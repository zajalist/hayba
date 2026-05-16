// GPU multi-scale erosion pyramid orchestrator → equirect `h_final` texture.
// Task A15 (Subsystem A, GPU port).
//
// =====================================================================
//  VERBATIM ALGORITHM MIRROR — PARITY IS LOAD-BEARING (A18 gates this)
// =====================================================================
// `runErodeBake` is the GPU port of the committed Rust CPU oracle
//   apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs
//     `run_pyramid_core` (the function this mirrors)
// composed from the A14 GLSL passes (`passes.glsl.ts`) driven over the
// A12 RGBA32F ping-pong framework (`pingpong.ts`).
//
// MIRROR PIN: this mirrors `run_pyramid_core` (+ `stream_power_step`,
// `thermal_step`, `deposition_step`, `upsample2x`+PD-fill, `inject_detail_band`,
// `box_lowpass_h`, the §5.5 frequency-separation blend, `cubesphere_to_equirect`)
// at committed HEAD
//   199d918c71e858c7a1c82283e1bbcb61a257b411 (branch feat/baking-pipeline).
// Same formulas, constants, signs, branch order, per-level cadence. The ONLY
// differences vs Rust are GLSL idiom + 6-faces-in-one-2D-atlas addressing +
// the *bounded-pass* decompositions the passes.glsl in-shader contracts
// explicitly delegate to this orchestrator (see DELEGATION below). A18
// enforces CPU↔GPU parity (RMSE < 2e-3 over land); ANY change to the Rust
// oracle (or to passes.glsl) MUST be mirrored here or A18 fails. Same
// contract as cubesphere.ts / passes.glsl.ts mirror-pins.
//
// ---------------------------------------------------------------------
//  A15-DELEGATED BOUNDED-PASS DECOMPOSITIONS (NORMATIVE — see passes.glsl)
// ---------------------------------------------------------------------
// passes.glsl delegates three GLOBAL algorithms to this orchestrator
// because a single fragment invocation cannot run an O(N) forest/sweep:
//
//  1. STREAM_POWER drainage area `A` (passes.glsl STREAM_POWER_FRAG, lines
//     681-687, NORMATIVE): "(1) per-cell steepest-descent receiver (same
//     formula as recv_and_slope / pyramid.rs Pass-1), then (2) Braun–Willett
//     O(N) topological-sort uphill accumulation (pyramid.rs Pass-2) ->
//     per-cell drainage area written to uState.b. A flood-fill / iterative
//     area estimate is NOT sufficient (A18 RMSE gate)."
//     Implemented here as: a steepest-descent-receiver pass, then the
//     Braun–Willett donor-sum recurrence  A[k] = Ω(k) + Σ_{recv[d]==k} A[d]
//     relaxed to its fixed point by N bounded Jacobi ping-pong passes.
//     This is the SAME forest fixed-point as the Rust topological sort (the
//     identical recurrence over the identical acyclic receiver forest — a
//     receiver is only chosen when strictly lower, so h strictly decreases
//     along every chain ⇒ the Jacobi relaxation converges in ≤ chain-depth
//     ≤ N steps to the EXACT same per-cell sum, term-for-term). It is the
//     bounded analogue of the topological sweep, NOT a divergent flood/
//     iterative estimate — exactly the sanctioned analogy fillPits uses for
//     the PD Gauss–Seidel sweep (passes.glsl GLSL_FILLPITS lines 566-578).
//
//  2. UPSAMPLE PD pit-fill (passes.glsl GLSL_FILLPITS lines 558-579 +
//     UPSAMPLE_FRAG mode 1, NORMATIVE): the unbounded Rust Gauss–Seidel PD
//     sweep loop, decomposed into N bounded Jacobi ping-pong passes of
//     UPSAMPLE_FRAG mode 1. The orchestrator seeds `uPrevW` (+∞ on interior
//     land, hk on ocean / global-min-land — exactly as Rust seeds the `w`
//     buffer) and supplies `uGlobalMinLand` (the land global-min outlet
//     level, == Rust `global_min`). Same PD fixed point.
//
//  3. §5.5 box-lowpass (pyramid.rs `box_lowpass_h`): the separable
//     neighbour box-blur, `passes = (final_res/base).max(1)` sweeps, as
//     `passes` bounded ping-pong passes of LOWPASS_FRAG (one sweep each,
//     seam-correct neighbour topology — the SAME kernel/cutoff Rust uses).
//
// ---------------------------------------------------------------------
//  Channel packing (one RGBA32F atlas; `.g`/`.b` are pass-multiplexed)
// ---------------------------------------------------------------------
// passes.glsl's `uState` is RGBA32F = (r=h, g=slope01|water, b=A|sed,
// a=ocean). `.g`/`.b` carry DIFFERENT semantics per pass:
//   DETAIL_BAND  reads slope01 in .g          (writes h, passes .g/.b/.a thru)
//   STREAM_POWER reads drainage area A in .b   (writes h, passes thru)
//   THERMAL      reads only h(.r)+ocean(.a)    (passes .g/.b thru)
//   UPSAMPLE m0  bilinear h; carries coarse .g/.b
//   UPSAMPLE m1  PD pit-fill on h (uPrevW)
//   UPSAMPLE m2  reads parent water .g / sed .b on the COARSE field
// So the CANONICAL persistent state keeps r=h, g=water, b=sed, a=ocean
// (matching upsample2x's water/sed carry + Field), and transient slope01/
// A are materialised into a SHORT-LIVED working atlas immediately before
// the pass that consumes them (then discarded). Helper passes that
// produce slope01 / receivers / drainage area are authored here (the
// orchestrator's own bounded multi-pass step that passes.glsl delegates).

import * as THREE from "three";
import {
  createPingPong,
  runPass,
  disposeRunPassCache,
  type PingPongTargets,
} from "./pingpong";
import {
  DETAIL_BAND_FRAG,
  STREAM_POWER_FRAG,
  THERMAL_FRAG,
  UPSAMPLE_FRAG,
  RESAMPLE_FRAG,
} from "./passes.glsl";

/* ===================================================================
 *  Event-loop yield (Phase-1 webview-unfreeze — RESULT-INVARIANT).
 *
 *  runErodeBake issues tens of thousands of GL passes (+ per-level
 *  full-res readbacks) with ZERO event-loop yields, which freezes the
 *  whole webview UI thread (Windows "not responding"/white screen) and
 *  starves the GL command queue. `yieldToLoop` parks the microtask
 *  chain on a MACROTASK (setTimeout(0)) so the browser event loop runs
 *  one turn — repaint, input, and (critically) the GL driver flushing
 *  its already-queued command buffer — between pass batches.
 *
 *  NOT requestAnimationFrame: `scene.runBake` PAUSES the render loop for
 *  the duration of the bake; while paused, RAF callbacks can be
 *  throttled/coalesced (or never fire if the tab is backgrounded), so a
 *  RAF-gated bake could stall indefinitely. A `setTimeout(0)` macrotask
 *  always fires regardless of render-loop / visibility state.
 *
 *  RESULT-INVARIANCE (LOAD-BEARING): all erosion state lives in the GPU
 *  ping-pong textures. The JS between `runInto`/`runPass` calls only
 *  ENQUEUES GL commands; it never mutates texture contents. Awaiting a
 *  macrotask here does NOT change GL command submission order or any
 *  texel — it only lets the event loop run and lets the driver drain
 *  the commands already queued. The only JS-side texture reads are the
 *  synchronous `computeGlobalMinLand` readbacks; yields are inserted
 *  only AROUND that call, never between its readRenderTargetPixels and
 *  its scan. Net: the bake output equirect is BIT-IDENTICAL with and
 *  without these yields. (No code reads a texture into JS and branches
 *  on it within a yielded region, and no GL call is reordered.)
 * =================================================================== */
const yieldToLoop = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

// Yield cadence inside the long bounded inner pass loops (pit-fill,
// flow-accum/relax, box-lowpass, …). Coarse enough not to tank GL
// throughput (one macrotask per 64 fullscreen passes is negligible vs
// the passes themselves), frequent enough to keep the webview UI thread
// alive (≤64 passes between repaints). Power-of-two so the `& 63` mask
// is exact.
const YIELD_EVERY = 64;

/* ===================================================================
 *  Config (mirror of Rust `ErosionConfig`, erosion/mod.rs).
 *  Field names are camelCase TS; the per-field meaning + defaults are
 *  byte-for-byte the Rust struct (so GPU formulas == CPU formulas).
 * =================================================================== */
export interface ErodeConfig {
  baseFaceRes: number; // Rust base_face_res — coarsest face res
  pyramidLevels: number; // Rust pyramid_levels — ×2 steps
  kItersPerLevel: number; // Rust k_iters_per_level
  erodibility: number; // Rust erodibility (K)
  areaExp: number; // Rust area_exp (m)
  slopeExp: number; // Rust slope_exp (n)
  incisionClamp: number; // Rust incision_clamp (ε)
  thermalD: number; // Rust thermal_d
  talusAngle: number; // Rust talus_angle
  thermalCadence: number; // Rust thermal_cadence
  depositionG: number; // Rust deposition_g (G)
  beta: number; // Rust beta (§5.5 detail-restoration gain)
  uplift: number; // Rust uplift — MUST be 0.0
  seed: number; // Rust seed (u64; JS number — low 53 bits, see seedToU64)
}

/** Rust `ErosionConfig::default()` (erosion/mod.rs), verbatim. */
export const DEFAULT_ERODE_CONFIG: ErodeConfig = {
  baseFaceRes: 64,
  pyramidLevels: 5,
  kItersPerLevel: 16,
  erodibility: 5e-5,
  areaExp: 0.5,
  slopeExp: 1.0,
  incisionClamp: 3e-4,
  thermalD: 0.08,
  talusAngle: 0.6,
  thermalCadence: 8,
  depositionG: 1.6,
  beta: 1.5,
  uplift: 0.0,
  seed: 0x9e3779b9,
};

/* ===================================================================
 *  HIERARCHICAL COARSE→FINE WARM-START (§6 HARDENING; residual risk #8).
 *
 *  Spec §6 + residual risk #8 are NORMATIVE: flow accumulation MUST be
 *  "hierarchical on the pyramid chain (coarse→fine, reusing the §5.4
 *  levels)" — NOT a flat full-res parallel-flood / Jacobi-relaxed-to-
 *  convergence over the finest grid. A flat O(6·n²)-pass Jacobi at the
 *  production finest (n=1024) is ~6.3M passes × 3 accumulations × 16
 *  K-iters/level ≈ 4e8 fullscreen passes ⇒ hours / guaranteed GPU
 *  watchdog TDR. That is the exact prohibited failure mode.
 *
 *  The fix carries each converged coarse-level field down to WARM-START
 *  the fine level (and warm-starts each K-iter from the previous K-iter's
 *  converged field — the h field moves by a small per-iter increment, so
 *  the fixed point moves by an O(1) sub-tree). The Braun–Willett donor
 *  sum is a contraction with a UNIQUE fixed point over the (unchanged)
 *  acyclic receiver forest (a receiver is chosen only when strictly
 *  lower ⇒ h strictly decreases along every chain ⇒ the forest is a DAG
 *  ⇒ the Jacobi map is nilpotent-to-fixed-point); the PD pit-fill is a
 *  monotone min-operator with a unique fixed point. A FIXED POINT IS
 *  INDEPENDENT OF THE INITIAL ITERATE: a closer seed cannot change the
 *  converged value, only how many passes reach it. So this changes ONLY
 *  the initial iterate + the pass cap — never the per-cell recurrence,
 *  the receiver/Ω formulas, or the converged value. A18 GPU↔CPU RMSE
 *  parity is therefore UNAFFECTED (it depends only on the fixed point).
 *
 *  With a coarse-seeded start the residual relaxation is the sub-tree
 *  added by ONE ×2 refinement = O(1) chain-depth, so a small constant
 *  refine cap converges. The COARSEST level (level 0, base=64 by
 *  default) still seeds from scratch (Ω / qs0) and runs a generous but
 *  BOUNDED from-scratch cap — cheap because n is small (6·64² ≈ 24.6k
 *  texels; the bounded cap there is the only place a ~6·n² depth is
 *  ever paid, and only at the smallest n). */
// Warm-started (fine-level + per-K-iter) accumulation/fill refine depth.
// One ×2 refinement adds O(1) chain-depth on top of a converged seed; a
// per-K-iter step perturbs h slightly ⇒ the donor/PD fixed point moves
// by an O(1) sub-tree. 16 Jacobi/PD passes amply covers that residual
// (8 typically suffices; 16 is a safety margin). NOT a function of n —
// this is what makes the finest level TDR-safe.
const ACCUM_REFINE_PASSES = 16;
// (No FILL_REFINE constant: the PD pit-fill is intentionally NOT warm-
// started — see the fillPasses note in runErodeBake. It keeps its exact
// Rust ∞ seed; only its cap is bounded — from O(6·n²) to O(8·n).)
// Coarsest-level (level 0) FROM-SCRATCH cap. Seeded from Ω/qs0 (no warm
// start available yet), so it must still relax the full base-res forest:
// bound = land-texel-count surrogate 6·n² (+slack), with an absolute
// ceiling so a pathological huge `baseFaceRes` cannot DoS the cap. At
// the default base=64 this is ~24.6k passes over a 64²·6 grid — fast
// (the whole point of the pyramid: pay the O(n²) relaxation ONCE, at the
// smallest n, then only O(1)-refine every finer level).
const BASE_FROM_SCRATCH_CAP_CEIL = 200_000;
function baseFromScratchCap(n: number): number {
  return Math.min(6 * n * n + 64, BASE_FROM_SCRATCH_CAP_CEIL);
}

/* ===================================================================
 *  pyramidSchedule — PURE, the only A15 unit-tested surface.
 *
 *  Mirrors `run_pyramid_core`: start field is `base_face_res.max(1)`;
 *  each level is `upsample2x` (×2 face res) except the finest which is
 *  not upsampled — so level L's face res is base*2^L, and there are
 *  `pyramid_levels.max(1)` levels.
 * =================================================================== */
export function pyramidSchedule(cfg: {
  baseFaceRes: number;
  pyramidLevels: number;
}): { faceRes: number }[] {
  // Rust: let base = cfg.base_face_res.max(1);
  const base = Math.max(1, Math.floor(cfg.baseFaceRes));
  // Rust: let levels = cfg.pyramid_levels.max(1);
  const levels = Math.max(1, Math.floor(cfg.pyramidLevels));
  const out: { faceRes: number }[] = [];
  for (let level = 0; level < levels; level++) {
    out.push({ faceRes: base * 2 ** level });
  }
  return out;
}

/* ===================================================================
 *  erodeAccumPassBudget — PURE. Total fullscreen accumulation/fill pass
 *  count for a schedule, mirroring runErodeBake's loop structure EXACTLY
 *  (3 warm-started accumulations × K-iters × levels + 1 PD fill per
 *  upsampled level). The ONLY level paying the from-scratch O(6·n²) cost
 *  is level 0 (smallest n); every finer level is O(1)-refine. This makes
 *  the §6 HARDENING TDR-feasibility claim locally unit-testable: the old
 *  flat O(6·n²)-every-level scheme was ~4e8 passes @ n=1024; this is
 *  ~thousands. NOT used by runErodeBake (it inlines the same caps) —
 *  exported purely so erodePipeline.test.ts can pin the budget. */
export function erodeAccumPassBudget(cfg: {
  baseFaceRes: number;
  pyramidLevels: number;
  kItersPerLevel: number;
}): number {
  const schedule = pyramidSchedule(cfg);
  const kIters = Math.max(0, Math.floor(cfg.kItersPerLevel));
  let total = 0;
  for (let level = 0; level < schedule.length; level++) {
    const n = schedule[level].faceRes;
    // 3 accumulations per K-iter (stream-power A, deposition A, QS).
    for (const which of [0, 1, 2]) {
      void which;
      for (let k = 0; k < kIters; k++) {
        // K-iter 0 of level 0 is the ONLY cold (from-scratch) start;
        // every other K-iter / level is warm-started.
        const cold = level === 0 && k === 0;
        total += cold ? baseFromScratchCap(n) : ACCUM_REFINE_PASSES;
      }
    }
    // PD pit-fill: once per UPSAMPLED level (not the finest), O(8·n).
    if (level + 1 < schedule.length) {
      const nf = schedule[level + 1].faceRes;
      total += Math.min(8 * nf + 64, BASE_FROM_SCRATCH_CAP_CEIL);
    }
  }
  return total;
}

/* ===================================================================
 *  u64 seed split. Rust `cfg.seed` is u64; passes.glsl takes uSeed as a
 *  uvec2 (x=lo32, y=hi32). JS numbers are f64 (53-bit safe ints). The
 *  Rust default seed (0x9E3779B9) and the per-level XOR `seed ^ level`
 *  stay well within 53 bits, so the split is exact for the production
 *  config; the contract is the same lo/hi packing passes.glsl's
 *  u64_const expects. (Bit-exact >2^53 seeds would need a BigInt; the
 *  oracle/default never use one — same f32-vs-f64 latitude as
 *  cubesphere.ts.)
 * =================================================================== */
function seedToU64(seed: number): THREE.Vector2 {
  const s = Math.floor(seed);
  const lo = s >>> 0;
  const hi = Math.floor(s / 4294967296) >>> 0;
  return new THREE.Vector2(lo, hi);
}

/* Atlas geometry: 6 faces tiled 3 wide × 2 tall (passes.glsl ATLAS). */
const ATLAS_COLS = 3;
const ATLAS_ROWS = 2;
function atlasSize(faceRes: number): { w: number; h: number } {
  return { w: faceRes * ATLAS_COLS, h: faceRes * ATLAS_ROWS };
}

/* ===================================================================
 *  Orchestrator-authored helper passes (the bounded multi-pass steps
 *  passes.glsl explicitly delegates to A15). They reuse the EXACT
 *  shared prelude (cube-sphere geometry / neighbourTexel / gather /
 *  cornerSlope3 / greatCircle / cellSolidAngle) so the receiver / slope
 *  / area formulas are the SAME f32 path passes.glsl + the Rust oracle
 *  use — zero structural divergence.
 *
 *  SLOPE01_FRAG  — pyramid.rs run_pyramid_core step (a): per land texel
 *    smax = max over real neighbours of |Δh|/great_circle, clamped
 *    [0,1]; ocean untouched. Writes slope01 into .g (DETAIL_BAND reads
 *    it there). r/b/a passed through.
 *
 *  RECV_FRAG     — pyramid.rs recv_and_slope: per land texel the
 *    steepest-descent receiver (great-circle slope, drop>0), the
 *    isCorner→cornerSlope3 magnitude substitution. Encodes the receiver
 *    as a packed neighbour-cell ref (face,i,j) + own solid angle. This
 *    is Rust stream_power Pass-1 (also reused by deposition).
 *
 *  AREA_INIT_FRAG / AREA_ACCUM_FRAG — Braun–Willett donor-sum:
 *    A0[k] = Ω(k) (cellSolidAngle, == Rust per-cell area). Then the
 *    Jacobi recurrence  A[k] = Ω(k) + Σ_{d∈nbr(k), recv[d]==k} A_prev[d]
 *    relaxed to its fixed point by N bounded passes (== the Rust
 *    topological forest sum; see DELEGATION note 1). Sinks/ocean keep
 *    Ω(k). The receiver of each neighbour `d` is recomputed inline with
 *    the SAME recv_and_slope formula (so the donor test is exact).
 *
 *  DEPOSITION combines into a single fragment what Rust deposition_step
 *    does AFTER its own (identical) receiver + Braun–Willett area +
 *    Braun–Willett Qs accumulation; those two accumulations are run by
 *    the orchestrator as bounded passes (same recurrence shape as the
 *    drainage area), then DEP_APPLY_FRAG applies h += dep (ε-clamped,
 *    ocean fixed) — verbatim pyramid.rs deposition_step Pass-3/apply.
 * =================================================================== */

// Shared prelude for helper passes: the EXACT chunk passes.glsl composes
// (GLSL_PREAMBLE→u64→noise→cubesphere→atlas→cornerSlope3). passes.glsl
// builds every exported pass as `GLSL_PRELUDE + <pass-specific>` and does
// NOT export GLSL_PRELUDE itself; rather than fork a second (drift-prone)
// copy of that ~600-line chunk, we recover it as the longest common
// prefix of two exported passes. DETAIL_BAND_FRAG and THERMAL_FRAG share
// GLSL_PRELUDE verbatim and then diverge at their first (different)
// uniform block, so the common prefix is EXACTLY GLSL_PRELUDE — keeping
// the helpers byte-identical to the ported cube-sphere / neighbour /
// cornerSlope3 / cellSolidAngle math with zero structural divergence and
// zero edits to passes.glsl (the A15 contract: no other-TS changes).
function longestCommonPrefix(a: string, b: string): string {
  const m = Math.min(a.length, b.length);
  let i = 0;
  while (i < m && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return a.slice(0, i);
}
// `HP` = GLSL_PRELUDE + the one pass-specific line DETAIL_BAND and
// THERMAL happen to share verbatim as their FIRST line:
// `uniform vec2 uResolution;`. That trailing line is BENIGN and in fact
// convenient — every helper pass needs `uResolution` anyway, so we let HP
// own the single declaration and do NOT redeclare it in
// COMMON_MAIN_DECODE (a second declaration would be a duplicate-uniform
// GLSL compile error). Everything else helpers need (geometry / atlas /
// gatherNeighbours / cornerSlope3 / cellSolidAngle / greatCircle /
// fetchCell / uState / uAtlasTexel / uManualBilinear) is inside the
// prelude proper, byte-identical to passes.glsl. (Verified: HP is stable
// across pass pairs and contains every shared symbol.)
const HP: string = longestCommonPrefix(DETAIL_BAND_FRAG, THERMAL_FRAG);

/* recv/slope helper used by RECV / AREA / DEPOSITION helper shaders.
 * Verbatim pyramid.rs recv_and_slope: steepest-descent over gathered
 * real neighbours by great-circle slope (drop>0), then the
 * isCorner→cornerSlope3 magnitude substitution. `outRecvFlat` is the
 * receiver as an atlas-cell index pack; -1 ⇒ sink/self (terminal). */
const RECV_SLOPE_GLSL = [
  "/* recv_and_slope (pyramid.rs). Returns slope in `oslope`, and the",
  "   receiver (nf,ni,nj) in out params; sink ⇒ rf<0. */",
  "void recvAndSlope(int f, int i, int j, vec3 p0, float h0,",
  "                  out float oslope, out int rf, out int ri, out int rj){",
  "  int nf[4]; int ni[4]; int nj[4];",
  "  int cnt = gatherNeighbours(f, i, j, nf, ni, nj);",
  "  float best_slope = 0.0;",
  "  int best_k = -1;",
  "  for (int k = 0; k < 4; k++){",
  "    if (k >= cnt) break;",
  "    float hk = fetchH(nf[k], ni[k], nj[k]);",
  "    float drop = h0 - hk;",
  "    if (drop <= 0.0) continue;",
  "    vec3 pk = cellPos(nf[k], ni[k], nj[k]);",
  "    float dist = greatCircle(p0, pk);",
  "    if (dist <= 1e-9) continue;",
  "    float s = drop / dist;",
  "    if (s > best_slope){ best_slope = s; best_k = k; }",
  "  }",
  "  if (best_k < 0){ oslope = 0.0; rf = -1; ri = -1; rj = -1; return; }",
  "  float slope = best_slope;",
  "  if (isCorner(i, j)){",
  "    float cs = cornerSlope3(p0, h0, cnt, nf, ni, nj);",
  "    if (cs == cs && abs(cs) < 3.4028235e38) slope = cs;",
  "  }",
  "  oslope = slope;",
  "  rf = nf[best_k]; ri = ni[best_k]; rj = nj[best_k];",
  "}",
  "",
].join("\n");

// NOTE: `uResolution` is already declared by HP (the prelude's trailing
// shared line) — do NOT redeclare it here (duplicate-uniform = compile
// error). This chunk only adds the fragment→atlas-UV decode helper.
const COMMON_MAIN_DECODE = [
  "vec2 _atlasUv(){ return gl_FragCoord.xy / uResolution; }",
  "",
].join("\n");

/* SLOPE01: pyramid.rs run_pyramid_core step (a). slope01 → .g. */
const SLOPE01_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  vec4 st = fetchCell(face, ci, cj);",
    "  if (st.a > 0.5){ fragColor = st; return; } /* ocean: slope01 stays */",
    "  float h0 = st.r;",
    "  int nf[4]; int ni[4]; int nj[4];",
    "  int cnt = gatherNeighbours(face, ci, cj, nf, ni, nj);",
    "  float smax = 0.0;",
    "  for (int k = 0; k < 4; k++){",
    "    if (k >= cnt) break;",
    "    vec3 pk = cellPos(nf[k], ni[k], nj[k]);",
    "    float d = greatCircle(p0, pk);",
    "    if (d > 1e-9){",
    "      float s = abs((h0 - fetchH(nf[k], ni[k], nj[k])) / d);",
    "      if (s > smax) smax = s;",
    "    }",
    "  }",
    "  float slope01 = clamp(smax, 0.0, 1.0);",
    "  fragColor = vec4(st.r, slope01, st.b, st.a);",
    "}",
  ].join("\n");

/* RECV: encode steepest-descent receiver as a flat atlas-cell ref.
 * Output channels: r=recvFaceFlat (face*MAXN*MAXN + ni*MAXN + nj, or -1
 * for sink/ocean), g=slope, b=cellSolidAngle Ω(k), a=ocean.
 * Reused as the receiver field for the area + deposition accumulations. */
const RECV_FRAG: string =
  HP +
  RECV_SLOPE_GLSL +
  COMMON_MAIN_DECODE +
  [
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  vec4 st = fetchCell(face, ci, cj);",
    "  float omega = cellSolidAngle(face, ci, cj);",
    "  if (st.a > 0.5){ fragColor = vec4(-1.0, 0.0, omega, 1.0); return; }",
    "  float oslope; int rf, ri, rj;",
    "  recvAndSlope(face, ci, cj, p0, st.r, oslope, rf, ri, rj);",
    "  float packed = -1.0;",
    "  if (rf >= 0){",
    "    /* Pack (rf,ri,rj) → one f32, EXACTLY. f32 has a 24-bit mantissa,",
    "       so consecutive integers are representable iff < 2^24. The packed",
    "       key is face·n² + i·n + j ≤ 6·n² (face≤5, i,j<n), so exactness",
    "       requires 6·n² < 2^24 ⇒ n ≲ 1672. This n-ceiling is LOAD-BEARING:",
    "       the AREA_ACCUM / QS_ACCUM donor test compares this packed key for",
    "       EQUALITY (|dpk-selfPacked|<0.5); above n≈1672 distinct cells alias",
    "       to the same f32 and the donor forest is silently corrupted (A18",
    "       parity + drainage break). Production (pyramidLevels:5 ⇒ n≤1024)",
    "       is safe; pyramidLevels≥6 ⇒ n≥2048 is NOT (guarded in runErodeBake",
    "       — the supported ceiling is ≤5 levels / n≤1672). */",
    "    float n = uFaceRes;",
    "    packed = float(rf) * n * n + float(ri) * n + float(rj);",
    "  }",
    "  fragColor = vec4(packed, oslope, omega, 0.0);",
    "}",
  ].join("\n");

/* AREA_INIT: A0[k] = Ω(k) (cellSolidAngle). uRecv carries the receiver
 * field (b=Ω). Writes A into .r of the working area atlas. */
const AREA_INIT_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uRecv;",
    "vec4 recvCell(int f,int i,int j){ return texture(uRecv, faceCellToAtlasUv(f,i,j)); }",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  float omega = recvCell(face, ci, cj).b;",
    "  fragColor = vec4(omega, 0.0, 0.0, 0.0);",
    "}",
  ].join("\n");

/* AREA_ACCUM: one Jacobi relaxation of the Braun–Willett donor sum
 *   A[k] = Ω(k) + Σ_{d ∈ realNbr(k), recv[d]==k} A_prev[d]
 * uRecv = the (static) receiver field; uPrevA = previous A iterate.
 * Fixed point == the Rust topological forest sum (DELEGATION note 1). */
const AREA_ACCUM_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uRecv;",
    "uniform sampler2D uPrevA;",
    "vec4 recvCell(int f,int i,int j){ return texture(uRecv, faceCellToAtlasUv(f,i,j)); }",
    "float prevA(int f,int i,int j){ return texture(uPrevA, faceCellToAtlasUv(f,i,j)).r; }",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  float omega = recvCell(face, ci, cj).b;",
    "  /* ocean keeps Ω (no upstream over ocean); sinks keep Ω too. */",
    "  float n = uFaceRes;",
    "  float selfPacked = float(face) * n * n + float(ci) * n + float(cj);",
    "  float acc = omega;",
    "  int nf[4]; int ni[4]; int nj[4];",
    "  int cnt = gatherNeighbours(face, ci, cj, nf, ni, nj);",
    "  for (int k = 0; k < 4; k++){",
    "    if (k >= cnt) break;",
    "    /* neighbour d drains into us iff recv[d] packs to (face,ci,cj). */",
    "    float dpk = recvCell(nf[k], ni[k], nj[k]).r;",
    "    if (dpk < 0.0) continue; /* d is a sink/ocean: no flow */",
    "    if (abs(dpk - selfPacked) < 0.5){",
    "      acc += prevA(nf[k], ni[k], nj[k]);",
    "    }",
    "  }",
    "  fragColor = vec4(acc, 0.0, 0.0, 0.0);",
    "}",
  ].join("\n");

/* QS_INIT: Rust deposition_step Pass-3 local supply
 *   qs0[k] = (land && recv!=sink) ? K·Aᵐ·Sⁿ : 0   (S = slope.max(0))
 * uRecv carries r=recvPacked, g=slope. uArea carries r=A. */
const QS_INIT_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uRecv;",
    "uniform sampler2D uArea;",
    "uniform float uErodibility;",
    "uniform float uAreaExp;",
    "uniform float uSlopeExp;",
    "vec4 recvCell(int f,int i,int j){ return texture(uRecv, faceCellToAtlasUv(f,i,j)); }",
    "float areaAt(int f,int i,int j){ return texture(uArea, faceCellToAtlasUv(f,i,j)).r; }",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  vec4 rc = recvCell(face, ci, cj);",
    "  if (rc.a > 0.5 || rc.r < 0.0){ fragColor = vec4(0.0); return; }",
    "  float s = max(rc.g, 0.0);",
    "  float A = areaAt(face, ci, cj);",
    "  float sup = uErodibility * pow(A, uAreaExp) * pow(s, uSlopeExp);",
    "  if (!(sup == sup) || abs(sup) >= 3.4028235e38 || sup <= 0.0) sup = 0.0;",
    "  fragColor = vec4(sup, 0.0, 0.0, 0.0);",
    "}",
  ].join("\n");

/* QS_ACCUM: one Jacobi relaxation of the routed-load forest sum.
 * Rust accumulates Qs downstream depositing the capacity excess as the
 * flux passes through. The NET load arriving at k from upstream is
 *   inflow[k] = Σ_{d: recv[d]==k} carriedOut[d]
 *   carriedHere[k] = qs0[k] + inflow[k]
 *   qc[k] = G·K·Aᵐ·Sⁿ ;  dep[k] = clamp(max(carriedHere−qc,0), 0, ε)
 *   carriedOut[k] = carriedHere[k] − dep[k]
 * Relaxing carriedOut to its fixed point over the acyclic forest yields
 * the SAME per-cell dep as the Rust leaf-first single pass (same terms,
 * same order of the deduction `qs -= d` before handing downstream — the
 * recurrence is order-independent because the deduction is local to k
 * and the forest is a DAG). uPrevOut = previous carriedOut iterate. */
const QS_ACCUM_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uRecv;",
    "uniform sampler2D uArea;",
    "uniform sampler2D uQs0;",
    "uniform sampler2D uPrevOut;",
    "uniform float uErodibility;",
    "uniform float uAreaExp;",
    "uniform float uSlopeExp;",
    "uniform float uDepositionG;",
    "uniform float uIncisionClamp;",
    "vec4 recvCell(int f,int i,int j){ return texture(uRecv, faceCellToAtlasUv(f,i,j)); }",
    "float areaAt(int f,int i,int j){ return texture(uArea, faceCellToAtlasUv(f,i,j)).r; }",
    "float qs0At(int f,int i,int j){ return texture(uQs0, faceCellToAtlasUv(f,i,j)).r; }",
    "float prevOut(int f,int i,int j){ return texture(uPrevOut, faceCellToAtlasUv(f,i,j)).r; }",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  vec4 rc = recvCell(face, ci, cj);",
    "  float n = uFaceRes;",
    "  float selfPacked = float(face) * n * n + float(ci) * n + float(cj);",
    "  /* inflow = Σ upstream carriedOut. */",
    "  float inflow = 0.0;",
    "  int nf[4]; int ni[4]; int nj[4];",
    "  int cnt = gatherNeighbours(face, ci, cj, nf, ni, nj);",
    "  for (int k = 0; k < 4; k++){",
    "    if (k >= cnt) break;",
    "    float dpk = recvCell(nf[k], ni[k], nj[k]).r;",
    "    if (dpk < 0.0) continue;",
    "    if (abs(dpk - selfPacked) < 0.5) inflow += prevOut(nf[k], ni[k], nj[k]);",
    "  }",
    "  /* ocean / sink: load just passes (no deposition; Rust only deposits",
    "     on is_land). carriedOut = qs0 + inflow. */",
    "  bool land = !(rc.a > 0.5);",
    "  float carried = qs0At(face, ci, cj) + inflow;",
    "  if (!land){ fragColor = vec4(carried, 0.0, 0.0, 0.0); return; }",
    "  float s = max(rc.g, 0.0);",
    "  float A = areaAt(face, ci, cj);",
    "  float qc = uDepositionG * uErodibility * pow(A, uAreaExp) * pow(s, uSlopeExp);",
    "  float d = 0.0;",
    "  if (carried > qc && (qc == qc) && abs(qc) < 3.4028235e38){",
    "    d = carried - qc;",
    "    if (!(d == d) || d < 0.0) d = 0.0;",
    "    d = min(d, uIncisionClamp);",
    "  }",
    "  fragColor = vec4(carried - d, 0.0, 0.0, 0.0);",
    "}",
  ].join("\n");

/* DEP_APPLY: Rust deposition_step apply. dep[k] = clamp(max(carriedHere
 * − qc,0),0,ε) recomputed from the converged inflow; h += dep on land
 * (≥0 guard), ocean fixed. uState=h field, uRecv/uArea/uQs0/uCarriedOut
 * the converged forest. Writes the new h field (g/b/a passed through). */
const DEP_APPLY_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uRecv;",
    "uniform sampler2D uArea;",
    "uniform sampler2D uQs0;",
    "uniform sampler2D uCarriedOut;",
    "uniform float uErodibility;",
    "uniform float uAreaExp;",
    "uniform float uSlopeExp;",
    "uniform float uDepositionG;",
    "uniform float uIncisionClamp;",
    "vec4 recvCell(int f,int i,int j){ return texture(uRecv, faceCellToAtlasUv(f,i,j)); }",
    "float areaAt(int f,int i,int j){ return texture(uArea, faceCellToAtlasUv(f,i,j)).r; }",
    "float qs0At(int f,int i,int j){ return texture(uQs0, faceCellToAtlasUv(f,i,j)).r; }",
    "float carriedOut(int f,int i,int j){ return texture(uCarriedOut, faceCellToAtlasUv(f,i,j)).r; }",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  vec4 st = fetchCell(face, ci, cj);",
    "  vec4 rc = recvCell(face, ci, cj);",
    "  if (rc.a > 0.5){ fragColor = st; return; } /* ocean fixed */",
    "  float n = uFaceRes;",
    "  float selfPacked = float(face) * n * n + float(ci) * n + float(cj);",
    "  float inflow = 0.0;",
    "  int nf[4]; int ni[4]; int nj[4];",
    "  int cnt = gatherNeighbours(face, ci, cj, nf, ni, nj);",
    "  for (int k = 0; k < 4; k++){",
    "    if (k >= cnt) break;",
    "    float dpk = recvCell(nf[k], ni[k], nj[k]).r;",
    "    if (dpk < 0.0) continue;",
    "    if (abs(dpk - selfPacked) < 0.5) inflow += carriedOut(nf[k], ni[k], nj[k]);",
    "  }",
    "  float carried = qs0At(face, ci, cj) + inflow;",
    "  float s = max(rc.g, 0.0);",
    "  float A = areaAt(face, ci, cj);",
    "  float qc = uDepositionG * uErodibility * pow(A, uAreaExp) * pow(s, uSlopeExp);",
    "  float d = 0.0;",
    "  if (carried > qc && (qc == qc) && abs(qc) < 3.4028235e38){",
    "    d = carried - qc;",
    "    if (!(d == d) || d < 0.0) d = 0.0;",
    "    d = min(d, uIncisionClamp);",
    "  }",
    "  float hOut = st.r;",
    "  if (d > 0.0 && (d == d)) hOut = max(st.r + d, 0.0);",
    "  fragColor = vec4(hOut, st.g, st.b, st.a);",
    "}",
  ].join("\n");

/* MERGE_A_INTO_B: copy the converged drainage area into the working
 * state's .b so STREAM_POWER_FRAG reads `A` from uState.b per its
 * in-shader contract (r/g/a preserved). */
const MERGE_A_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uArea;",
    "float areaAt(int f,int i,int j){ return texture(uArea, faceCellToAtlasUv(f,i,j)).r; }",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  vec4 st = fetchCell(face, ci, cj);",
    "  fragColor = vec4(st.r, st.g, areaAt(face, ci, cj), st.a);",
    "}",
  ].join("\n");

/* SEED_W_FRAG: PD pit-fill seed. Rust seeds the `w` buffer: ocean / land
 * already ≤ global_min ⇒ true h; interior land ⇒ +∞. is_land = h≥0. */
const SEED_W_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform float uGlobalMinLand;",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  float hk = fetchH(face, ci, cj);",
    "  bool land = hk >= 0.0;",
    "  float w;",
    "  if (!land) w = hk;",
    "  else if (hk <= uGlobalMinLand + 1e-9) w = hk;",
    "  else w = 3.4028235e38; /* +inf surrogate (Rust f32::INFINITY) */",
    "  fragColor = vec4(w, 0.0, 0.0, 0.0);",
    "}",
  ].join("\n");

/* LOWPASS_FRAG: one separable neighbour box-blur sweep over the
 * seam-correct topology — verbatim pyramid.rs box_lowpass_h inner sweep
 * (mean of self + each distinct real neighbour). uSrc = previous sweep. */
const LOWPASS_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uSrc;",
    "float srcAt(int f,int i,int j){ return texture(uSrc, faceCellToAtlasUv(f,i,j)).r; }",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  float acc = srcAt(face, ci, cj);",
    "  float cnt = 1.0;",
    "  ivec2 steps[4] = ivec2[4](ivec2(1,0), ivec2(-1,0), ivec2(0,1), ivec2(0,-1));",
    "  for (int s = 0; s < 4; s++){",
    "    int nf, ni, nj;",
    "    neighbourTexel(face, ci + steps[s].x, cj + steps[s].y, nf, ni, nj);",
    "    if (nf == face && ni == ci && nj == cj) continue;",
    "    acc += srcAt(nf, ni, nj); cnt += 1.0;",
    "  }",
    "  fragColor = vec4(acc / cnt, 0.0, 0.0, 0.0);",
    "}",
  ].join("\n");

/* H0_RESAMPLE_FRAG: pyramid.rs §5.5 `h0_fine` — bilinear-resample the
 * pristine source h to the FINAL face res via the same cube-sphere
 * round-trip upsample2x uses (sphere → src face → 4 bracketing src cell
 * centres). uSrcH0 = the source h0 atlas at uSrcFaceRes. */
const H0_RESAMPLE_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uSrcH0;",
    "uniform float uSrcFaceRes;",
    // NORMATIVE: must stay bit-identical to wizard.rs::bake_h0_v2_impl serialisation + uploadH0.ts::xyForFaceTexel (tri-source atlas layout; silent divergence breaks A18 parity with no compile error).
    "vec2 srcFaceUvToAtlas(int f, float fu, float fv){",
    "  float tileX = float(f - 3 * (f / 3));",
    "  float tileY = float(f / 3);",
    "  return vec2((tileX + fu) / ATLAS_COLS, (tileY + fv) / ATLAS_ROWS);",
    "}",
    "float srcCell(int f, int i, int j){",
    "  float ns = uSrcFaceRes;",
    "  float fu = (float(i)+0.5)/ns; float fv = (float(j)+0.5)/ns;",
    "  return texture(uSrcH0, srcFaceUvToAtlas(f, fu, fv)).r;",
    "}",
    "void main(){",
    "  int face, fi, fj; vec3 p;",
    "  faceTexelToSpherePos(_atlasUv(), face, fi, fj, p);",
    "  int sf; float su; float sv;",
    "  sphereToFaceUv(p, sf, su, sv);",
    "  float snc = uSrcFaceRes;",
    "  float fx = clamp(su * snc - 0.5, 0.0, snc - 1.0);",
    "  float fy = clamp(sv * snc - 0.5, 0.0, snc - 1.0);",
    "  int i0 = int(floor(fx)); int j0 = int(floor(fy));",
    "  int i1 = min(i0 + 1, int(snc) - 1);",
    "  int j1 = min(j0 + 1, int(snc) - 1);",
    "  float tx = fx - float(i0); float ty = fy - float(j0);",
    "  float h00 = srcCell(sf, i0, j0);",
    "  float h10 = srcCell(sf, i1, j0);",
    "  float h01 = srcCell(sf, i0, j1);",
    "  float h11 = srcCell(sf, i1, j1);",
    "  float a = h00 + (h10 - h00) * tx;",
    "  float b = h01 + (h11 - h01) * tx;",
    "  fragColor = vec4(a + (b - a) * ty, 0.0, 0.0, 0.0);",
    "}",
  ].join("\n");

/* SEED_UPSAMPLE_FRAG: bilinear-resample ONE `.r`-channel warm-start field
 * (converged drainage area `A`, or the converged PD-filled `w`/`h`) from
 * a coarse atlas to the fine atlas. Structurally byte-identical to
 * H0_RESAMPLE_FRAG / UPSAMPLE_FRAG mode-0 — the SAME cube-sphere
 * round-trip (sphereToFaceUv → 4 bracketing coarse cell centres →
 * clamped 4-tap bilinear) the `h` upsample path uses, so the warm field
 * is carried down on EXACTLY the level-seam-consistent path `h` is. This
 * is a PURE INITIAL-ITERATE transport: it never enters any per-cell
 * recurrence/formula — it only chooses where the Jacobi/PD relaxation
 * starts. The fixed point (hence A18 parity) is unaffected (the donor
 * forest / PD operator each have a unique fixed point independent of the
 * initial iterate; see DELEGATION note 1 + the fixed-point invariance
 * note at the level loop). uSeedSrc = coarse warm atlas @ uSeedSrcRes. */
const SEED_UPSAMPLE_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uSeedSrc;",
    "uniform float uSeedSrcRes;",
    "vec2 seedFaceUvToAtlas(int f, float fu, float fv){",
    "  float tileX = float(f - 3 * (f / 3));",
    "  float tileY = float(f / 3);",
    "  return vec2((tileX + fu) / ATLAS_COLS, (tileY + fv) / ATLAS_ROWS);",
    "}",
    "float seedCell(int f, int i, int j){",
    "  float ns = uSeedSrcRes;",
    "  float fu = (float(i)+0.5)/ns; float fv = (float(j)+0.5)/ns;",
    "  return texture(uSeedSrc, seedFaceUvToAtlas(f, fu, fv)).r;",
    "}",
    "void main(){",
    "  int face, fi, fj; vec3 p;",
    "  faceTexelToSpherePos(_atlasUv(), face, fi, fj, p);",
    "  int sf; float su; float sv;",
    "  sphereToFaceUv(p, sf, su, sv);",
    "  float snc = uSeedSrcRes;",
    "  float fx = clamp(su * snc - 0.5, 0.0, snc - 1.0);",
    "  float fy = clamp(sv * snc - 0.5, 0.0, snc - 1.0);",
    "  int i0 = int(floor(fx)); int j0 = int(floor(fy));",
    "  int i1 = min(i0 + 1, int(snc) - 1);",
    "  int j1 = min(j0 + 1, int(snc) - 1);",
    "  float tx = fx - float(i0); float ty = fy - float(j0);",
    "  float h00 = seedCell(sf, i0, j0);",
    "  float h10 = seedCell(sf, i1, j0);",
    "  float h01 = seedCell(sf, i0, j1);",
    "  float h11 = seedCell(sf, i1, j1);",
    "  float a = h00 + (h10 - h00) * tx;",
    "  float b = h01 + (h11 - h01) * tx;",
    "  fragColor = vec4(a + (b - a) * ty, 0.0, 0.0, 0.0);",
    "}",
  ].join("\n");

/* BLEND_FRAG: §5.5 frequency-separation macro blend (pyramid.rs, NOT a
 * lerp): land-only h = lowpass(h0) + β·(h_eroded − lowpass(h_eroded)),
 * .max(0); ocean keeps the eroded/base level. uState = eroded field;
 * uLpEroded = box_lowpass(h_eroded); uLpH0 = box_lowpass(h0_fine). */
const BLEND_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uLpEroded;",
    "uniform sampler2D uLpH0;",
    "uniform float uBeta;",
    "float lpEro(int f,int i,int j){ return texture(uLpEroded, faceCellToAtlasUv(f,i,j)).r; }",
    "float lpH0(int f,int i,int j){ return texture(uLpH0, faceCellToAtlasUv(f,i,j)).r; }",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  vec4 st = fetchCell(face, ci, cj);",
    "  if (st.a > 0.5){ fragColor = st; return; } /* ocean untouched */",
    "  float detail = st.r - lpEro(face, ci, cj);",
    "  float corrected = lpH0(face, ci, cj) + uBeta * detail;",
    "  float hOut = st.r;",
    "  if (corrected == corrected && abs(corrected) < 3.4028235e38)",
    "    hOut = max(corrected, 0.0);",
    "  fragColor = vec4(hOut, st.g, st.b, st.a);",
    "}",
  ].join("\n");

/* RESTRICT_FRAG: run_pyramid_core start-field build when src.cs.n > base
 * (production path): nearest cell-centre through the real cube-sphere
 * geometry (seam-correct inverse of upsample). Copies h/water/sed/ocean
 * from the resolved src cell. uSrc = source atlas at uSrcFaceRes. */
const RESTRICT_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uSrc;",
    "uniform float uSrcFaceRes;",
    // NORMATIVE: must stay bit-identical to wizard.rs::bake_h0_v2_impl serialisation + uploadH0.ts::xyForFaceTexel (tri-source atlas layout; silent divergence breaks A18 parity with no compile error).
    "vec2 srcFaceUvToAtlas(int f, float fu, float fv){",
    "  float tileX = float(f - 3 * (f / 3));",
    "  float tileY = float(f / 3);",
    "  return vec2((tileX + fu) / ATLAS_COLS, (tileY + fv) / ATLAS_ROWS);",
    "}",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  int sf; float su; float sv;",
    "  sphereToFaceUv(p0, sf, su, sv);",
    "  float ns = uSrcFaceRes;",
    "  int si = clamp(int(floor(su * ns)), 0, int(ns) - 1);",
    "  int sj = clamp(int(floor(sv * ns)), 0, int(ns) - 1);",
    "  float fu = (float(si)+0.5)/ns; float fv = (float(sj)+0.5)/ns;",
    // NORMATIVE: derive start-field ocean (.a) from the rasterised cell height
    // sign — bit-identical to CPU `src.ocean = elev < 0.0` (pyramid.rs::
    // rasterize_from_cells L216 / run_pyramid_core L1384,L1409). uploadH0.ts
    // serialises ONLY h into .r and leaves .a=0, so a passthrough would key
    // every texel as land and collapse h_final to 0 (Defect-2). R/G/B pass
    // through unchanged; only .a is corrected (a crisp 0/1 mask, NOT lerped —
    // matches the CPU nearest-cell restrict copy of the per-cell `ocean` bool).
    "  vec4 s = texture(uSrc, srcFaceUvToAtlas(sf, fu, fv));",
    "  fragColor = vec4(s.r, s.g, s.b, s.r < 0.0 ? 1.0 : 0.0);",
    "}",
  ].join("\n");

/* COPY_FRAG: identity copy of uState (channel-faithful) — used to
 * snapshot the eroded field for the h0-independent lowpass inputs. */
const COPY_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  fragColor = fetchCell(face, ci, cj);",
    "}",
  ].join("\n");

/* ===================================================================
 *  GPU helpers — minimal RT alloc + a single-pass runner that writes a
 *  fragment into a *specific* render target (the helper accumulations
 *  need explicit src/dst control, distinct from pingpong's channel
 *  ping-pong). Uses the same cached-material path as runPass via a
 *  one-channel PingPongTargets shim where convenient.
 * =================================================================== */

/**
 * The min/mag filter for scratch RTs. The ping-pong only ever picks
 * Nearest (manualBilinear) or Linear (hw float-linear) — both are valid
 * Magnification filters, but `PingPongTargets.filter` is typed as the
 * wider `TextureFilter` union, so narrow it off `manualBilinear` (the
 * single source of truth, per pingpong.ts's NORMATIVE note).
 */
function rtFilter(
  targets: PingPongTargets,
): THREE.MagnificationTextureFilter {
  return targets.manualBilinear ? THREE.NearestFilter : THREE.LinearFilter;
}

/** Allocate a single RGBA32F render target matching the ping-pong opts. */
function makeRT(
  targets: PingPongTargets,
  w: number,
  h: number,
): THREE.WebGLRenderTarget {
  const f = rtFilter(targets);
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: f,
    magFilter: f,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
}

// A reusable fullscreen-quad shader runner that renders `frag` with
// `uniforms` into an explicit `dst` RT. Mirrors runPass's cached-material
// discipline (no per-pass recompile) but with explicit src/dst (the
// accumulation passes are not simple channel ping-pong).
const _quadGeom = new THREE.PlaneGeometry(2, 2);
const _quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const _quadScene = new THREE.Scene();
const _quadMat = new THREE.ShaderMaterial({
  vertexShader: "void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }",
  fragmentShader: "void main(){}",
  glslVersion: THREE.GLSL3,
  depthTest: false,
  depthWrite: false,
});
const _quadMesh = new THREE.Mesh(_quadGeom, _quadMat);
_quadMesh.frustumCulled = false;
_quadScene.add(_quadMesh);
const _helperMatCache = new Map<string, THREE.ShaderMaterial>();

function runInto(
  renderer: THREE.WebGLRenderer,
  frag: string,
  uniforms: Record<string, THREE.IUniform>,
  dst: THREE.WebGLRenderTarget,
): void {
  let mat = _helperMatCache.get(frag);
  if (!mat) {
    mat = new THREE.ShaderMaterial({
      vertexShader: "void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: frag,
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
    });
    _helperMatCache.set(frag, mat);
  }
  mat.uniforms = uniforms;
  _quadMesh.material = mat;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(dst);
  renderer.render(_quadScene, _quadCam);
  renderer.setRenderTarget(prev);
}

function disposeHelperCache(): void {
  for (const m of _helperMatCache.values()) m.dispose();
  _helperMatCache.clear();
}

/* ===================================================================
 *  runErodeBake — the GPU pyramid orchestrator.
 *
 *  Mirrors `run_pyramid_core(src, cfg, true, None)` exactly, composed
 *  from the A14 GLSL passes + the A15-delegated bounded multi-passes.
 *
 *  `srcH0Tex` is the source `h0` atlas (RGBA32F, 3×2-tiled, r=h, g=water,
 *  b=sed, a=ocean) at `srcFaceRes` per face — A16 produces it; here it
 *  is the macro reference + the start field.
 *
 *  Returns the equirect (`equirectW × equirectH`) RGBA32F
 *  `THREE.WebGLRenderTarget` (NOT just its `.texture`). The caller owns
 *  it and MUST call `rt.dispose()` exactly once when done — that frees
 *  BOTH the GL framebuffer (`deallocateRenderTarget`) AND `rt.texture`
 *  (a bare `rt.texture.dispose()` leaks the framebuffer). Use
 *  `rt.texture` wherever the sampled equirect texture is needed. Every
 *  other GPU resource is freed before return.
 * =================================================================== */
export async function runErodeBake(
  renderer: THREE.WebGLRenderer,
  srcH0Tex: THREE.Texture,
  cfg: ErodeConfig & {
    srcFaceRes: number;
    equirectW: number;
    equirectH: number;
  },
  onProgress?: (level: number, k: number) => void,
): Promise<THREE.WebGLRenderTarget> {
  const schedule = pyramidSchedule(cfg);
  const base = Math.max(1, Math.floor(cfg.baseFaceRes));
  const levels = schedule.length;
  const finalRes = schedule[levels - 1].faceRes;

  // n-ceiling guard (LOAD-BEARING — see RECV_FRAG pack comment). The
  // receiver is packed as face·n²+i·n+j into ONE f32; the AREA_ACCUM /
  // QS_ACCUM donor test compares that key for equality. f32 has a 24-bit
  // mantissa ⇒ exact integers only below 2^24; the max key is ≈6·n², so
  // exactness needs 6·n² < 2^24 ⇒ n ≲ 1672. Above that, distinct cells
  // alias to the same f32, silently corrupting the donor forest (A18
  // parity + drainage break). Production pyramidLevels:5 ⇒ n≤1024 (safe);
  // pyramidLevels≥6 ⇒ n≥2048 is UNSUPPORTED — hard-fail with a clear
  // message rather than emit a corrupted bake.
  const PACK_N_CEIL = 1672; // floor(sqrt((2^24)/6))
  if (finalRes > PACK_N_CEIL) {
    throw new Error(
      `runErodeBake: finest face res ${finalRes} exceeds the f32 ` +
        `receiver-pack ceiling (${PACK_N_CEIL}). The donor-equality test ` +
        `aliases above 6·n²≥2^24 and would silently corrupt drainage/parity. ` +
        `Supported ceiling: ≤5 pyramid levels at base 64 (n≤1024), or any ` +
        `base·2^(levels-1) ≤ ${PACK_N_CEIL}.`,
    );
  }

  // One ping-pong "state" channel (the canonical RGBA32F field atlas:
  // r=h, g=water, b=sed, a=ocean). Allocated at the FINAL res so it can
  // hold every level (we render only the active res's sub-rectangle and
  // address it via uFaceRes — but to keep the cube-atlas addressing
  // exact, we re-allocate per level at that level's res instead).
  const seedVec = seedToU64(cfg.seed);

  // Per-level we work in a fresh atlas sized to that level. The state
  // ping-pong + scratch RTs are (re)allocated per level (face res grows
  // ×2 each level; old level RTs are disposed before the next).
  let stateTargets: PingPongTargets | null = null;
  let curRes = base;
  let scratch: THREE.WebGLRenderTarget[] = [];

  const disposeScratch = () => {
    for (const rt of scratch) rt.dispose();
    scratch = [];
  };

  // --- Hierarchical coarse→fine warm-start state (§6 HARDENING). ------
  // PERSISTENT single-channel (.r) warm fields, kept ALIVE across K-iters
  // AND across pyramid levels (disposeScratch must NOT free them). Each
  // holds the LAST converged value of its accumulation/fill, used as the
  // next iterate's seed. Carried L→L+1 by SEED_UPSAMPLE_FRAG (the same
  // seam-correct bilinear round-trip the `h` upsample uses). NOT in the
  // converged-value path — only the initial iterate (fixed-point
  // invariant; see the warm-start note above). `warmRes` is the face res
  // the warm RTs are currently allocated at.
  // The three FLOW-ACCUMULATION fixed points (Braun–Willett donor sum +
  // routed-load) are PURE-ADDITIVE Jacobi maps over an acyclic receiver
  // forest (`acc = Ω + Σ prevA`; QS adds a per-cell post-clamp that is a
  // function of the cell's own converged inputs) — affine, nilpotent
  // (spectral radius 0 on a DAG), converging in exactly chain-depth steps
  // from ANY finite seed. So a closer (coarse-upsampled / previous-K-iter)
  // seed CANNOT change the fixed point — only the pass count. These ARE
  // warm-started (the §6 HARDENING target). The PD pit-fill is NOT
  // warm-started (monotone-DECREASING ⇒ requires a super-solution seed;
  // see the fillPasses note) — it keeps the exact Rust ∞ seed.
  let warmSpA: THREE.WebGLRenderTarget | null = null; // stream-power A
  let warmDepA: THREE.WebGLRenderTarget | null = null; // deposition A
  let warmDepOut: THREE.WebGLRenderTarget | null = null; // dep routed-load
  let warmRes = 0;
  const disposeWarm = () => {
    for (const rt of [warmSpA, warmDepA, warmDepOut]) rt?.dispose();
    warmSpA = warmDepA = warmDepOut = null;
    warmRes = 0;
  };
  // Bilinear-resample one persistent warm RT coarse→fine onto a fresh RT
  // at `fineRes` (the EXACT round-trip the `h` upsample uses). Returns
  // the new fine RT (caller adopts ownership; old coarse RT disposed).
  const upsampleWarm = (
    src: THREE.WebGLRenderTarget | null,
    coarseRes: number,
    fineTargets: PingPongTargets,
    fineRes: number,
  ): THREE.WebGLRenderTarget | null => {
    if (!src) return null;
    const [fw, fh] = szTuple(fineRes);
    const dst = makeRT(fineTargets, fw, fh);
    runInto(
      renderer,
      SEED_UPSAMPLE_FRAG,
      {
        uResolution: { value: new THREE.Vector2(fw, fh) },
        uFaceRes: { value: fineRes },
        uAtlasTexel: {
          value: new THREE.Vector2(
            1 / (fineRes * ATLAS_COLS),
            1 / (fineRes * ATLAS_ROWS),
          ),
        },
        uManualBilinear: { value: fineTargets.manualBilinear ? 1 : 0 },
        uSeedSrc: { value: src.texture },
        uSeedSrcRes: { value: coarseRes },
      },
      dst,
    );
    src.dispose();
    return dst;
  };

  // --- Build the start field at base res from srcH0Tex. --------------
  // run_pyramid_core: src.cs.n == base → verbatim; src.cs.n > base →
  // nearest-cell restrict through the cube-sphere; src.cs.n < base →
  // conservative upsample. We always RESTRICT/resample srcH0Tex into a
  // fresh base-res atlas (RESTRICT_FRAG is the seam-correct nearest path
  // and is identity when srcFaceRes==base; the <base upsample case is
  // not produced by A16's rasteriser — src is always ≥ base).
  {
    stateTargets = createPingPong(renderer, ...szTuple(base), ["state"]);
    const dst = stateTargets.rt["state"][stateTargets.book.write("state")];
    runInto(
      renderer,
      RESTRICT_FRAG,
      {
        uResolution: { value: new THREE.Vector2(...szTuple(base)) },
        uFaceRes: { value: base },
        uSrc: { value: srcH0Tex },
        uSrcFaceRes: { value: cfg.srcFaceRes },
        uManualBilinear: { value: stateTargets.manualBilinear ? 1 : 0 },
        uAtlasTexel: {
          value: new THREE.Vector2(
            1 / (base * ATLAS_COLS),
            1 / (base * ATLAS_ROWS),
          ),
        },
      },
      dst,
    );
    stateTargets.book.swap("state");
  }

  // h0 source kept for the §5.5 macro reference (resampled to finalRes
  // after the level loop) — that is srcH0Tex itself (independent of the
  // eroded field; no circularity, exactly run_pyramid_core).

  // --- Per-level pyramid (coarse → fine). ---------------------------
  for (let level = 0; level < levels; level++) {
    const n = curRes;
    const [aw, ah] = szTuple(n);
    const res = new THREE.Vector2(aw, ah);
    const texel = new THREE.Vector2(
      1 / (n * ATLAS_COLS),
      1 / (n * ATLAS_ROWS),
    );
    const st = stateTargets as PingPongTargets;
    const stateTex = () => st.rt["state"][st.book.read("state")].texture;
    const baseUniforms = () => ({
      uResolution: { value: res },
      uFaceRes: { value: n },
      uAtlasTexel: { value: texel },
      uManualBilinear: { value: st.manualBilinear ? 1 : 0 },
    });

    const isFinest = level + 1 === levels;

    // (a) slope01 → .g  (run_pyramid_core step (a): great-circle
    //     gradient normalised, ocean skipped).
    runPass(
      renderer,
      st,
      SLOPE01_FRAG,
      { ...baseUniforms(), uState: { value: stateTex() } },
      "state",
    );

    // (a) inject seam-continuous detail band. Amplitude tapers with
    //     level: amp = incision_clamp * 8 * (1 + level)  (run_pyramid_core).
    //     uSeed = cfg.seed ^ level (Rust: cfg.seed ^ level as u64).
    const amp = cfg.incisionClamp * 8.0 * (1.0 + level);
    const lvlSeed = seedXorLevel(seedVec, level);
    runPass(
      renderer,
      st,
      DETAIL_BAND_FRAG,
      {
        ...baseUniforms(),
        uState: { value: stateTex() },
        uSeed: { value: lvlSeed },
        uLevel: { value: level },
        uAmp: { value: amp },
      },
      "state",
    );

    // Warm RTs are allocated at THIS level's res. On level entry they
    // are either (a) absent (level 0 — seed from scratch) or (b) the
    // coarse-level converged fields upsampled into this res at the END of
    // the previous level (warmRes === n already). If a config edge ever
    // leaves them at the wrong res, drop them (fall back to from-scratch
    // — still correct, just one slow level).
    if (warmRes !== n) disposeWarm();

    // relaxAccum: run a Jacobi/PD accumulation to its fixed point with a
    // WARM START. `warmRef` names the persistent warm RT (carried across
    // K-iters + levels). On first use at a res it's seeded from
    // `fromScratch()` and run `baseFromScratchCap(n)` passes (coarsest
    // level / cold start); thereafter it's seeded from the previous
    // converged value and run only `refineCap` passes (the residual after
    // a small h-perturbation or one ×2 refinement is an O(1) sub-tree).
    // The per-cell `accumFrag` recurrence + uniforms are UNCHANGED — only
    // the initial iterate + pass count differ ⇒ the unique fixed point
    // (hence A18 parity) is invariant. Returns the texture holding the
    // converged field (lives in the persistent warm RT — caller must
    // consume it before the next relaxAccum on the same warmRef).
    const ensureWarm = (
      cur: THREE.WebGLRenderTarget | null,
    ): { rt: THREE.WebGLRenderTarget; cold: boolean } => {
      if (cur && warmRes === n) return { rt: cur, cold: false };
      const rt = makeRT(st, aw, ah);
      warmRes = n;
      return { rt, cold: true };
    };
    const relaxAccum = async (
      which: "spA" | "depA" | "depOut",
      fromScratch: (dst: THREE.WebGLRenderTarget) => void,
      accumFrag: string,
      accumUniforms: (prevTex: THREE.Texture) => Record<string, THREE.IUniform>,
      refineCap: number,
    ): Promise<THREE.Texture> => {
      const cur =
        which === "spA" ? warmSpA : which === "depA" ? warmDepA : warmDepOut;
      const { rt: warm, cold } = ensureWarm(cur);
      if (which === "spA") warmSpA = warm;
      else if (which === "depA") warmDepA = warm;
      else warmDepOut = warm;
      // Iterate ping-pong (transient scratch, freed each K-iter).
      const it0 = makeRT(st, aw, ah);
      const it1 = makeRT(st, aw, ah);
      scratch.push(it0, it1);
      // Seed iterate: cold ⇒ from-scratch init; warm ⇒ previous converged.
      if (cold) {
        fromScratch(it0);
      } else {
        runInto(
          renderer,
          COPY_R_FRAG,
          { ...baseUniforms(), uSrcR: { value: warm.texture } },
          it0,
        );
      }
      let s = it0;
      let d = it1;
      const passes = cold ? baseFromScratchCap(n) : refineCap;
      for (let i = 0; i < passes; i++) {
        runInto(renderer, accumFrag, accumUniforms(s.texture), d);
        const tmp = s;
        s = d;
        d = tmp;
        // Yield every YIELD_EVERY passes so the webview UI thread + GL
        // command queue can drain. Result-invariant: only enqueued GL
        // commands run between iterations; no texel is read into JS here.
        if ((i & (YIELD_EVERY - 1)) === 0) await yieldToLoop();
      }
      // Snapshot the converged iterate into the PERSISTENT warm RT (next
      // K-iter / next level seeds from it). The warm RT is NOT in
      // `scratch`, so disposeScratch() at K-iter end leaves it intact.
      runInto(
        renderer,
        COPY_R_FRAG,
        { ...baseUniforms(), uSrcR: { value: s.texture } },
        warm,
      );
      return warm.texture;
    };

    // (b) NORMATIVE per-level order: erode → thermal → deposition.
    //     thermal THROTTLED to every cfg.thermal_cadence-th K-iter.
    const cadence = Math.max(1, Math.floor(cfg.thermalCadence));
    for (let k = 0; k < Math.max(0, Math.floor(cfg.kItersPerLevel)); k++) {
      // --- stream_power_step ---
      // Pass 1+2 (A15-delegated): receiver + Braun–Willett drainage area.
      // §6 HARDENING: the donor sum is relaxed with a HIERARCHICAL
      // coarse→fine (+ per-K-iter) WARM START, NOT a flat full-res
      // Jacobi-to-convergence (the prohibited TDR mode). The recurrence
      // (AREA_ACCUM_FRAG) + receiver field are byte-unchanged; only the
      // initial iterate (= last converged A, upsampled L→L+1) + the pass
      // count change ⇒ the unique forest fixed point is invariant.
      const recvRT = makeRT(st, aw, ah);
      scratch.push(recvRT);
      runInto(
        renderer,
        RECV_FRAG,
        { ...baseUniforms(), uState: { value: stateTex() } },
        recvRT,
      );
      const spArea = await relaxAccum(
        "spA",
        // cold seed: A0 = Ω(k) (AREA_INIT — exact Rust per-cell area).
        (dst) =>
          runInto(
            renderer,
            AREA_INIT_FRAG,
            { ...baseUniforms(), uRecv: { value: recvRT.texture } },
            dst,
          ),
        AREA_ACCUM_FRAG,
        (prevTex) => ({
          ...baseUniforms(),
          uRecv: { value: recvRT.texture },
          uPrevA: { value: prevTex },
        }),
        ACCUM_REFINE_PASSES,
      );
      // Merge converged A into state.b (STREAM_POWER reads A from .b).
      runPass(
        renderer,
        st,
        MERGE_A_FRAG,
        {
          ...baseUniforms(),
          uState: { value: stateTex() },
          uArea: { value: spArea },
        },
        "state",
      );
      // Pass 3: clamped incision (the faithful A14 STREAM_POWER_FRAG).
      runPass(
        renderer,
        st,
        STREAM_POWER_FRAG,
        {
          ...baseUniforms(),
          uState: { value: stateTex() },
          uErodibility: { value: cfg.erodibility },
          uAreaExp: { value: cfg.areaExp },
          uSlopeExp: { value: cfg.slopeExp },
          uIncisionClamp: { value: cfg.incisionClamp },
        },
        "state",
      );

      // --- thermal_step (every cadence-th iter) ---
      if (k % cadence === 0) {
        runPass(
          renderer,
          st,
          THERMAL_FRAG,
          {
            ...baseUniforms(),
            uState: { value: stateTex() },
            uThermalD: { value: cfg.thermalD },
            uTalusAngle: { value: cfg.talusAngle },
          },
          "state",
        );
      }

      // --- deposition_step ---
      // Receiver + drainage area for THIS field state (recomputed; the
      // h field changed since stream-power — deposition_step recomputes
      // its own recv/area exactly the same way).
      const dRecv = makeRT(st, aw, ah);
      const qs0 = makeRT(st, aw, ah);
      scratch.push(dRecv, qs0);

      runInto(
        renderer,
        RECV_FRAG,
        { ...baseUniforms(), uState: { value: stateTex() } },
        dRecv,
      );
      // Deposition drainage area — SAME AREA_ACCUM recurrence, warm-
      // started (coarse→fine + per-K-iter) exactly like stream-power's.
      const depArea = await relaxAccum(
        "depA",
        (dst) =>
          runInto(
            renderer,
            AREA_INIT_FRAG,
            { ...baseUniforms(), uRecv: { value: dRecv.texture } },
            dst,
          ),
        AREA_ACCUM_FRAG,
        (prevTex) => ({
          ...baseUniforms(),
          uRecv: { value: dRecv.texture },
          uPrevA: { value: prevTex },
        }),
        ACCUM_REFINE_PASSES,
      );
      // qs0 = local sediment supply (Rust deposition Pass-3 supply).
      const depSpUniforms = {
        ...baseUniforms(),
        uRecv: { value: dRecv.texture },
        uArea: { value: depArea },
        uErodibility: { value: cfg.erodibility },
        uAreaExp: { value: cfg.areaExp },
        uSlopeExp: { value: cfg.slopeExp },
      };
      runInto(renderer, QS_INIT_FRAG, depSpUniforms, qs0);
      // Routed-load (carriedOut) — SAME QS_ACCUM recurrence, warm-
      // started. Cold seed = qs0 (inflow 0, exactly the prior seed); warm
      // seed = last converged carriedOut. The QS forest fixed point is
      // unique over the acyclic receiver forest ⇒ seed-invariant.
      const carriedOut = await relaxAccum(
        "depOut",
        (dst) =>
          runInto(
            renderer,
            COPY_R_FRAG,
            { ...baseUniforms(), uSrcR: { value: qs0.texture } },
            dst,
          ),
        QS_ACCUM_FRAG,
        (prevTex) => ({
          ...baseUniforms(),
          uRecv: { value: dRecv.texture },
          uArea: { value: depArea },
          uQs0: { value: qs0.texture },
          uPrevOut: { value: prevTex },
          uErodibility: { value: cfg.erodibility },
          uAreaExp: { value: cfg.areaExp },
          uSlopeExp: { value: cfg.slopeExp },
          uDepositionG: { value: cfg.depositionG },
          uIncisionClamp: { value: cfg.incisionClamp },
        }),
        ACCUM_REFINE_PASSES,
      );
      // Apply deposition (h += dep, ε-clamped, ocean fixed).
      runPass(
        renderer,
        st,
        DEP_APPLY_FRAG,
        {
          ...baseUniforms(),
          uState: { value: stateTex() },
          uRecv: { value: dRecv.texture },
          uArea: { value: depArea },
          uQs0: { value: qs0.texture },
          uCarriedOut: { value: carriedOut },
          uErodibility: { value: cfg.erodibility },
          uAreaExp: { value: cfg.areaExp },
          uSlopeExp: { value: cfg.slopeExp },
          uDepositionG: { value: cfg.depositionG },
          uIncisionClamp: { value: cfg.incisionClamp },
        },
        "state",
      );

      // Free this K-iter's accumulation scratch (bake-then-watch: keep
      // GPU memory bounded across the hot loop).
      disposeScratch();

      onProgress?.(level, k);
      // Once-per-K-iter macrotask yield (alongside the progress callback)
      // so the webview can repaint progress + the driver can drain this
      // K-iter's queued passes. Result-invariant (all state is in GPU
      // textures; only enqueued GL commands run during the yield).
      await yieldToLoop();
    }

    // (c) upsample ×2 unless finest.
    if (!isFinest) {
      const nf = n * 2;
      const [fw, fh] = szTuple(nf);
      const fineRes = new THREE.Vector2(fw, fh);
      const fineTexel = new THREE.Vector2(
        1 / (nf * ATLAS_COLS),
        1 / (nf * ATLAS_ROWS),
      );
      const coarseTex = st.rt["state"][st.book.read("state")].texture;

      // New fine state ping-pong.
      const fineTargets = createPingPong(renderer, fw, fh, ["state"]);
      const fineBase = () => ({
        uResolution: { value: fineRes },
        uFaceRes: { value: nf },
        uAtlasTexel: { value: fineTexel },
        uManualBilinear: { value: fineTargets.manualBilinear ? 1 : 0 },
      });

      // mode 0: bilinear h from the coarse atlas.
      runPass(
        renderer,
        fineTargets,
        UPSAMPLE_FRAG,
        {
          ...fineBase(),
          uState: {
            value: fineTargets.rt["state"][fineTargets.book.read("state")]
              .texture,
          },
          uUpsampleMode: { value: 0 },
          uCoarseFaceRes: { value: n },
          uCoarse: { value: coarseTex },
          uCoarseTexel: { value: texel },
        },
        "state",
      );

      // mode 1: PD pit-fill — N bounded Jacobi passes. Seed uPrevW (+∞
      // interior land, hk ocean / global-min-land) and supply
      // uGlobalMinLand (== Rust global_min over the post-bilinear fine h).
      const gmin = computeGlobalMinLand(renderer, fineTargets, nf, fineBase);
      const wA = makeRT(fineTargets, fw, fh);
      const wB = makeRT(fineTargets, fw, fh);
      scratch.push(wA, wB);
      const fineStateTex = () =>
        fineTargets.rt["state"][fineTargets.book.read("state")].texture;
      // Seed w.
      runInto(
        renderer,
        SEED_W_FRAG,
        {
          ...fineBase(),
          uState: { value: fineStateTex() },
          uGlobalMinLand: { value: gmin },
        },
        wA,
      );
      let wSrc = wA;
      let wDst = wB;
      // PD pit-fill pass cap. IMPORTANT: the PD step (fillPits, passes.glsl)
      // is `w_new = min(wprev, max(hk, min_nbr_w))` — MONOTONE
      // NON-INCREASING. Its unique fixed point is reached ONLY from a
      // valid super-solution; the canonical one is `+∞` on interior land
      // (exactly the Rust seed — SEED_W_FRAG, unchanged here). A
      // coarse→fine warm start is NOT applied to the PD fill: a bilinear-
      // upsampled coarse `w*` can dip BELOW the fine fixed point inside
      // pits whose rim only exists at fine resolution (detail band), and
      // the monotone-decreasing scheme would lock those cells below the
      // true fixed point — i.e. it would CHANGE the converged value and
      // break A18 parity. That is the prohibited "divergent approximation"
      // (spec residual-risk #8 is about flow *accumulation*, which IS
      // warm-started above; the PD fill keeps its exact ∞ seed). What WAS
      // wrong is only the cap: a `+∞`-seeded Jacobi PD propagates the
      // outlet exactly ONE cell-ring per pass, so it converges in
      // O(longest fill path) = O(basin diameter) ≤ O(face perimeter)
      // passes, NOT O(6·n²). The old `6·n²` cap (~1.5M @ nf=1024) was
      // wildly over-provisioned and itself TDR-infeasible. Bound it at a
      // generous O(n) envelope (full cube-sphere diameter ≈ a few face
      // widths; ×8 + slack covers pathological winding basins) — exact
      // same ∞ seed ⇒ exact same PD fixed point ⇒ A18 unaffected, and
      // TDR-safe (nf=1024 ⇒ ≤ ~8.2k passes vs ~6.3M).
      const fillPasses = Math.min(8 * nf + 64, BASE_FROM_SCRATCH_CAP_CEIL);
      for (let it = 0; it < fillPasses; it++) {
        // UPSAMPLE_FRAG mode 1 reads h from uState(.r) + uPrevW; writes w.
        runInto(
          renderer,
          UPSAMPLE_FRAG,
          {
            ...fineBase(),
            uState: { value: fineStateTex() },
            uUpsampleMode: { value: 1 },
            uCoarseFaceRes: { value: n },
            uCoarse: { value: coarseTex },
            uCoarseTexel: { value: texel },
            uPrevW: { value: wSrc.texture },
            uGlobalMinLand: { value: gmin },
          },
          wDst,
        );
        const tmp = wSrc;
        wSrc = wDst;
        wDst = tmp;
        // Yield every YIELD_EVERY PD pit-fill passes. Result-invariant:
        // the PD fixed point is in the GPU ping-pong (wSrc/wDst); the
        // yield only flushes already-queued passes, never a JS readback.
        if ((it & (YIELD_EVERY - 1)) === 0) await yieldToLoop();
      }
      // Commit the filled h back into the fine state's .r (mode 1 output
      // is w; write it into state.r, ocean/g/b preserved).
      runPass(
        renderer,
        fineTargets,
        WRITE_W_FRAG,
        {
          ...fineBase(),
          uState: { value: fineStateTex() },
          uW: { value: wSrc.texture },
        },
        "state",
      );

      // mode 2: exact area-weighted water/sed split + ocean from
      // post-fill h. Reads parent water/sed from the COARSE atlas.
      runPass(
        renderer,
        fineTargets,
        UPSAMPLE_FRAG,
        {
          ...fineBase(),
          uState: { value: fineStateTex() },
          uUpsampleMode: { value: 2 },
          uCoarseFaceRes: { value: n },
          uCoarse: { value: coarseTex },
          uCoarseTexel: { value: texel },
        },
        "state",
      );

      disposeScratch();

      // §6 HARDENING — carry the converged coarse-level flow fields DOWN
      // to warm-start the fine level. Each persistent warm RT (the last
      // converged stream-power A / deposition A / routed-load at coarse
      // res `n`) is bilinear-resampled to fine res `nf` via
      // SEED_UPSAMPLE_FRAG — the SAME seam-correct cube-sphere round-trip
      // UPSAMPLE_FRAG mode 0 uses for `h` (so the warm field is carried
      // on exactly the level-seam-consistent path the height field is).
      // This is PURE initial-iterate transport (the additive-Jacobi
      // forest fixed point is seed-invariant; see the warm-start note) —
      // it makes the fine level's first K-iter converge in
      // ACCUM_REFINE_PASSES instead of O(6·nf²). Done AFTER disposeScratch
      // (warm RTs are not scratch) and BEFORE st.dispose (warm RTs were
      // allocated against `st` but SEED_UPSAMPLE only samples their
      // texture into a fresh fineTargets RT, so the old GL texture is
      // fully consumed before st is freed).
      warmSpA = upsampleWarm(warmSpA, n, fineTargets, nf);
      warmDepA = upsampleWarm(warmDepA, n, fineTargets, nf);
      warmDepOut = upsampleWarm(warmDepOut, n, fineTargets, nf);
      if (warmSpA || warmDepA || warmDepOut) warmRes = nf;

      st.dispose();
      stateTargets = fineTargets;
      curRes = nf;
    }

    // End-of-pyramid-level macrotask yield (fires for every level,
    // including the finest). Lets the webview repaint + the GL driver
    // drain this level's full pass batch before the next level's
    // (larger) atlas is allocated. Result-invariant: state lives in the
    // GPU ping-pong (stateTargets); the yield only flushes queued GL.
    await yieldToLoop();
  }

  // --- §5.5 frequency-separation macro blend. -----------------------
  const st = stateTargets as PingPongTargets;
  const [fw, fh] = szTuple(finalRes);
  const fres = new THREE.Vector2(fw, fh);
  const ftexel = new THREE.Vector2(
    1 / (finalRes * ATLAS_COLS),
    1 / (finalRes * ATLAS_ROWS),
  );
  const fBase = () => ({
    uResolution: { value: fres },
    uFaceRes: { value: finalRes },
    uAtlasTexel: { value: ftexel },
    uManualBilinear: { value: st.manualBilinear ? 1 : 0 },
  });
  const stateTexF = () => st.rt["state"][st.book.read("state")].texture;

  // h0_fine = bilinear-resample the pristine source to finalRes (same
  // cube-sphere round-trip; independent of the eroded field).
  const h0Fine = makeRT(st, fw, fh);
  scratch.push(h0Fine);
  runInto(
    renderer,
    H0_RESAMPLE_FRAG,
    {
      ...fBase(),
      uSrcH0: { value: srcH0Tex },
      uSrcFaceRes: { value: cfg.srcFaceRes },
    },
    h0Fine,
  );

  // lowpass passes = (finalRes / base).max(1) (the §5.5 macro cutoff).
  const lpPasses = Math.max(1, Math.floor(finalRes / base));

  // Snapshot eroded h into a scratch RT (lowpass input must be the
  // pre-blend eroded h, independent of the running state ping-pong).
  const eroH = makeRT(st, fw, fh);
  scratch.push(eroH);
  runInto(
    renderer,
    COPY_FRAG,
    { ...fBase(), uState: { value: stateTexF() } },
    eroH,
  );

  const lpEroded = await boxLowpass(
    renderer,
    st,
    finalRes,
    fBase,
    eroH,
    lpPasses,
    scratch,
  );
  const lpH0 = await boxLowpass(
    renderer,
    st,
    finalRes,
    fBase,
    h0Fine,
    lpPasses,
    scratch,
  );

  // Blend (land only; ocean keeps eroded/base level): write final h.
  runPass(
    renderer,
    st,
    BLEND_FRAG,
    {
      ...fBase(),
      uState: { value: stateTexF() },
      uLpEroded: { value: lpEroded.texture },
      uLpH0: { value: lpH0.texture },
      uBeta: { value: cfg.beta },
    },
    "state",
  );

  // --- RESAMPLE cube-atlas → equirect (RGBA32F). --------------------
  const eqF = rtFilter(st);
  const equiRT = new THREE.WebGLRenderTarget(cfg.equirectW, cfg.equirectH, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: eqF,
    magFilter: eqF,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  runInto(
    renderer,
    RESAMPLE_FRAG,
    {
      ...fBase(),
      uState: { value: stateTexF() },
      uEquirectSize: {
        value: new THREE.Vector2(cfg.equirectW, cfg.equirectH),
      },
    },
    equiRT,
  );

  // --- Teardown (bake-then-watch: free every GPU resource except the
  //     returned equirect render target — the caller owns equiRT and
  //     disposes it (FBO + texture) when done). -----------------------
  disposeScratch();
  disposeWarm(); // persistent coarse→fine warm RTs (not in `scratch`)
  st.dispose();
  disposeRunPassCache();
  disposeHelperCache();

  return equiRT;
}

/* ---- small GPU sub-routines ------------------------------------- */

function szTuple(faceRes: number): [number, number] {
  const { w, h } = atlasSize(faceRes);
  return [w, h];
}

/** cfg.seed ^ (level as u64) — XOR on the lo word (level < 2^32). */
function seedXorLevel(seed: THREE.Vector2, level: number): THREE.Vector2 {
  return new THREE.Vector2((seed.x ^ (level >>> 0)) >>> 0, seed.y >>> 0);
}

/**
 * Box-lowpass `srcRT.r` by `passes` separable neighbour-mean sweeps
 * (pyramid.rs box_lowpass_h, NORMATIVE — the §5.5 macro-cutoff kernel).
 * Both internal ping-pong RTs are registered into `track` so the
 * caller's single `disposeScratch()` (run AFTER the BLEND pass consumes
 * the result) frees them — no GPU-mem leak across the bake-then-watch
 * boundary. Resolves to the RT holding the lowpassed h in .r.
 *
 * `async` ONLY to interleave Phase-1 event-loop yields between sweep
 * batches (webview-unfreeze). The numerical behaviour is byte-unchanged:
 * the sweeps are the same separable neighbour-mean over the same GPU
 * ping-pong; the yield merely flushes already-queued GL between sweeps.
 */
async function boxLowpass(
  renderer: THREE.WebGLRenderer,
  targets: PingPongTargets,
  faceRes: number,
  baseUniforms: () => Record<string, THREE.IUniform>,
  srcRT: THREE.WebGLRenderTarget,
  passes: number,
  track: THREE.WebGLRenderTarget[],
): Promise<THREE.WebGLRenderTarget> {
  const [w, h] = szTuple(faceRes);
  let a = makeRT(targets, w, h);
  let b = makeRT(targets, w, h);
  track.push(a, b);
  // seed `a` with src.r
  runInto(
    renderer,
    COPY_R_FRAG,
    {
      uResolution: baseUniforms().uResolution,
      uFaceRes: baseUniforms().uFaceRes,
      uSrcR: { value: srcRT.texture },
    },
    a,
  );
  for (let p = 0; p < Math.max(1, passes); p++) {
    runInto(
      renderer,
      LOWPASS_FRAG,
      { ...baseUniforms(), uSrc: { value: a.texture } },
      b,
    );
    const tmp = a;
    a = b;
    b = tmp;
    // Yield every YIELD_EVERY lowpass sweeps. Result-invariant: the
    // lowpass field is in the GPU ping-pong (a/b); the yield only
    // flushes already-queued GL — no JS readback in this loop.
    if ((p & (YIELD_EVERY - 1)) === 0) await yieldToLoop();
  }
  // Both `a` and `b` are registered in `track` (== the caller's scratch)
  // and freed by the single post-BLEND disposeScratch(); the result is
  // whichever buffer `a` points at after the final swap.
  return a;
}

/**
 * Rust `global_min` over the post-bilinear fine land h: min h where
 * h≥0. No GPU reduction primitive here — read back the state texture
 * and scan on the CPU (one readback per upsample level; cheap relative
 * to the erosion loop and exactly matches the Rust scalar).
 */
function computeGlobalMinLand(
  renderer: THREE.WebGLRenderer,
  targets: PingPongTargets,
  faceRes: number,
  _baseUniforms: () => Record<string, THREE.IUniform>,
): number {
  const [w, h] = szTuple(faceRes);
  const src = targets.rt["state"][targets.book.read("state")];
  const buf = new Float32Array(w * h * 4);
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(src);
  renderer.readRenderTargetPixels(src, 0, 0, w, h, buf);
  renderer.setRenderTarget(prev);
  let gmin = Infinity;
  for (let i = 0; i < w * h; i++) {
    const hv = buf[i * 4]; // .r = h
    if (hv >= 0.0 && hv < gmin) gmin = hv;
  }
  return Number.isFinite(gmin) ? gmin : 0.0;
}

/* COPY_R: write src.r into .r of the target (g/b/a = 0). Seeds the
 * lowpass + carriedOut iterates from a single-channel scratch. */
const COPY_R_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uSrcR;",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  float r = texture(uSrcR, faceCellToAtlasUv(face, ci, cj)).r;",
    "  fragColor = vec4(r, 0.0, 0.0, 0.0);",
    "}",
  ].join("\n");

/* WRITE_W: commit the PD-filled w into state.r (g/b/a preserved). */
const WRITE_W_FRAG: string =
  HP +
  COMMON_MAIN_DECODE +
  [
    "uniform sampler2D uW;",
    "void main(){",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(_atlasUv(), face, ci, cj, p0);",
    "  vec4 st = fetchCell(face, ci, cj);",
    "  float wv = texture(uW, faceCellToAtlasUv(face, ci, cj)).r;",
    "  fragColor = vec4(wv, st.g, st.b, st.a);",
    "}",
  ].join("\n");
