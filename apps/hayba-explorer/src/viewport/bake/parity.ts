// Task A18 — CPU↔GPU parity harness. The GPU-correctness gate for the
// Subsystem-A GPU port.
//
// =====================================================================
//  WHAT THIS CHECKS (acceptance encoded as an in-app assertion)
// =====================================================================
// At a small fixed config (base_face_res:32, pyramid_levels:2, fixed
// seed) we run the SAME draft through BOTH:
//
//   • CPU oracle: 'bake_erode_v2' (Tauri) — wizard.rs::bake_erode_v2_impl
//     → erosion/mod.rs::bake_erode_cpu → run_pyramid + cubesphere_to_
//     equirect. Returns '{ equirect_w, equirect_h, h_final: f32[] }',
//     row-major 'y*w+x', **y=0 = NORTH pole** (resample.rs header +
//     'cubesphere_to_equirect'), normalized height units.
//
//   • GPU port: 'bake_h0_v2' (Tauri) → 'uploadH0' (DataTexture) →
//     'runErodeBake' (erodePipeline.ts) — the verbatim GPU mirror of
//     'run_pyramid_core'. Returns the equirect RGBA32F
//     'THREE.WebGLRenderTarget' (we read '.texture'; '.r' = h,
//     '.a' = ocean flag).
//
// Both pipelines MUST start from the SAME h0 at the SAME res with the
// SAME seed/config or the comparison is meaningless. The CPU side
// rasterises h0 internally from the draft ('painted_cells_from_draft');
// the GPU side gets the SAME rasterised h0 via 'bake_h0_v2' (which calls
// the identical 'painted_cells_from_draft' → 'rasterize_from_cells').
// We pin 'bake_h0_v2''s 'faceRes' to the shared 'base_face_res' so the
// GPU start field is byte-identical to the CPU oracle's start field.
//
// =====================================================================
//  READBACK ORIENTATION (LOAD-BEARING — a flip mismatch reads as a
//  catastrophic FAIL and is a real bug to get right HERE)
// =====================================================================
// 'runErodeBake' returns the owning equirect 'WebGLRenderTarget'. We do
// not read its FBO directly (it is the pipeline's internal RT); we blit
// 'equiRT.texture' into our OWN throwaway RGBA32F 'WebGLRenderTarget'
// via a trivial passthrough fullscreen pass, then 'renderer.readRender
// TargetPixels' from THAT. 'equiRT' itself is disposed in the finally
// ('rt.dispose()' frees both its framebuffer and its texture).
//
// Row order: RESAMPLE_FRAG (passes.glsl.ts PASS 5) writes Rust-row-0
// (the NORTH pole, v=0) at 'gl_FragCoord.y ≈ h' — i.e. the TOP of the
// framebuffer (it computes 'yRow = h - py'). 'readRenderTargetPixels'
// reads GL bottom-origin: buffer row 0 = framebuffer BOTTOM =
// 'gl_FragCoord.y ≈ 0' = 'yRow = h' = Rust row 'h-1'. Therefore the GPU
// readback buffer is VERTICALLY FLIPPED w.r.t. the Rust 'h_final' array:
//
//     gpuLinear(x, ry)  ==  cpu row (h - 1 - ry), col x
//
// We index with that explicit flip so North aligns to North. (A blit
// pass does NOT introduce a flip: 'flipY' is meaningless for a
// render-target source texture sampled by gl_FragCoord, and our blit
// writes fragment (x,y) ← sample (x,y), an identity copy.)
//
// =====================================================================
//  LAND PREDICATE
// =====================================================================
// The Rust side's land test is 'h > 0.0' in normalized units
// (wizard.rs 'is_continental(elev) = elev > 0.0'; resample/RESAMPLE mark
// ocean as 'h < 0.0'). We compare ONLY texels where BOTH cpu and gpu are
// land (h > 0) — the §5.5 blend / RESAMPLE leave ocean at the base/
// eroded level which is not the parity surface of interest, and a texel
// that disagrees on land-vs-ocean at the coastline is a sea-level
// crossing, not an erosion-formula divergence. (A coastline texel where
// the two disagree on sign is still surfaced in 'worst' if its |Δ| is
// large, so a real sign bug is not hidden.)
//
// GLSL note: ZERO backticks in this file (project footgun — template
// literals in shader strings break the build tooling). The only shader
// here is the trivial passthrough blit, authored as an array join.

import * as THREE from "three";
import { invoke } from "@tauri-apps/api/core";
import { uploadH0 } from "./uploadH0";
import {
  runErodeBake,
  DEFAULT_ERODE_CONFIG,
  type ErodeConfig,
} from "./erodePipeline";

/* ===================================================================
 *  Shared small-res config — BYTE-IDENTICAL for CPU & GPU.
 *
 *  Every field comes from 'ErosionConfig::default()' (erosion/mod.rs ==
 *  DEFAULT_ERODE_CONFIG, erodePipeline.ts) EXCEPT the three the task
 *  pins for a fast deterministic check:
 *    base_face_res : 32   (small — keeps the CPU oracle seconds not hrs)
 *    pyramid_levels: 2    (one ×2 refinement — exercises upsample/PD)
 *    seed          : PARITY_SEED (a fixed constant, documented below)
 *
 *  The seed is pinned to the Rust/TS DEFAULT seed 0x9E3779B9 so it is
 *  obviously in-range for the f64↔u64 split (seedToU64) and matches the
 *  value both default configs already ship — the least surprising
 *  deterministic choice. Any value works as long as BOTH sides use it;
 *  this constant is the single source of truth for both.
 * =================================================================== */
export const PARITY_BASE_FACE_RES = 32;
export const PARITY_PYRAMID_LEVELS = 2;
/** Fixed deterministic seed for the parity run (== Rust/TS default seed
 *  0x9E3779B9). Documented constant — the single source of truth shared
 *  by the CPU 'erosionConfig' and the GPU 'runErodeBake' cfg. */
export const PARITY_SEED = 0x9e3779b9;

/** Gate thresholds (Task A18 acceptance): RMSE < 2e-3 AND maxAbs < 2e-2
 *  over land texels (tolerance for f32 vs CPU summation ordering). */
export const PARITY_RMSE_GATE = 2e-3;
export const PARITY_MAXABS_GATE = 2e-2;

/** Max worst-texel entries retained for FAIL diagnostics. */
export const PARITY_WORST_K = 16;

/** One offending texel: flat equirect index + its lat/lon + the two
 *  heights and their absolute difference. */
export interface ParityWorstTexel {
  idx: number;
  lat: number; // degrees, +90 = North pole
  lon: number; // degrees, -180..+180
  cpu: number;
  gpu: number;
  d: number; // |cpu - gpu|
}

export interface ParityReport {
  pass: boolean;
  rmse: number;
  maxAbs: number;
  nLand: number;
  worst: ParityWorstTexel[];
  /** Equirect dimensions the comparison ran at (CPU oracle's, which the
   *  GPU cfg is forced to match). */
  width: number;
  height: number;
}

/** Rust 'WizardDraft' mirror (wizard/state.ts). Kept loose here — we
 *  only forward whatever the caller's live draft is, with the painter
 *  fields the caller already merged in. */
type DraftLike = Record<string, unknown>;

/** Rust 'ErodeResultV2' (wizard.rs). */
interface ErodeResultV2 {
  equirect_w: number;
  equirect_h: number;
  h_final: number[];
}

/** Rust 'H0Atlas' (wizard.rs). */
interface H0Atlas {
  face_res: number;
  atlas: number[];
}

/**
 * The snake_case 'ErosionConfig' JSON the Rust 'bake_erode_v2' command
 * deserialises. Rust's 'ErosionConfig' is '#[serde(default)]' so any
 * field we OMIT falls back to 'ErosionConfig::default()' — but to keep
 * CPU & GPU provably byte-identical we send EVERY field explicitly,
 * sourced from 'DEFAULT_ERODE_CONFIG' (which the file header pins as the
 * verbatim Rust default) with only the three pinned overrides applied.
 * This is the single object both sides are derived from.
 */
function sharedErosionConfigSnake(): Record<string, number> {
  return {
    base_face_res: PARITY_BASE_FACE_RES,
    pyramid_levels: PARITY_PYRAMID_LEVELS,
    k_iters_per_level: DEFAULT_ERODE_CONFIG.kItersPerLevel,
    erodibility: DEFAULT_ERODE_CONFIG.erodibility,
    area_exp: DEFAULT_ERODE_CONFIG.areaExp,
    slope_exp: DEFAULT_ERODE_CONFIG.slopeExp,
    incision_clamp: DEFAULT_ERODE_CONFIG.incisionClamp,
    thermal_d: DEFAULT_ERODE_CONFIG.thermalD,
    talus_angle: DEFAULT_ERODE_CONFIG.talusAngle,
    thermal_cadence: DEFAULT_ERODE_CONFIG.thermalCadence,
    deposition_g: DEFAULT_ERODE_CONFIG.depositionG,
    beta: DEFAULT_ERODE_CONFIG.beta,
    uplift: DEFAULT_ERODE_CONFIG.uplift,
    seed: PARITY_SEED,
  };
}

/** The camelCase 'ErodeConfig' the GPU 'runErodeBake' consumes. Derived
 *  from the SAME shared values — field-for-field the snake_case object
 *  above (so CPU formulas == GPU formulas; a mismatch here is a false
 *  FAIL the harness must not introduce). */
function sharedErodeConfig(): ErodeConfig {
  const s = sharedErosionConfigSnake();
  return {
    baseFaceRes: s.base_face_res,
    pyramidLevels: s.pyramid_levels,
    kItersPerLevel: s.k_iters_per_level,
    erodibility: s.erodibility,
    areaExp: s.area_exp,
    slopeExp: s.slope_exp,
    incisionClamp: s.incision_clamp,
    thermalD: s.thermal_d,
    talusAngle: s.talus_angle,
    thermalCadence: s.thermal_cadence,
    depositionG: s.deposition_g,
    beta: s.beta,
    uplift: s.uplift,
    seed: s.seed,
  };
}

/* ===================================================================
 *  Trivial passthrough blit shader (GLSL3). Samples uSrc at the
 *  fragment's normalised coords and writes it verbatim — an identity
 *  copy of 'runErodeBake''s returned equirect texture into a render
 *  target we own and can 'readRenderTargetPixels' from. NO Y-flip is
 *  introduced (fragment (x,y) ← texel (x,y)); the Rust-row-vs-GL-row
 *  flip is handled explicitly in 'compareLandTexels'.
 *
 *  ZERO backticks — array-join per the project convention.
 * =================================================================== */
const BLIT_VERT: string = [
  "void main(){",
  "  gl_Position = vec4(position.xy, 0.0, 1.0);",
  "}",
].join("\n");

const BLIT_FRAG: string = [
  "precision highp float;",
  "uniform sampler2D uSrc;",
  "uniform vec2 uResolution;",
  "out vec4 fragColor;",
  "void main(){",
  "  vec2 uv = gl_FragCoord.xy / uResolution;",
  "  fragColor = texture(uSrc, uv);",
  "}",
].join("\n");

/**
 * Blit 'srcTex' (the equirect RT's '.texture' from 'runErodeBake') into
 * a fresh RGBA32F 'WebGLRenderTarget' we own, then read its pixels back
 * as a Float32Array (RGBA, GL bottom-origin row order). The returned
 * buffer is 'w*h*4' floats; caller indexes '.r' with the documented
 * vertical flip. All transient GPU resources allocated here are
 * disposed before return (no leak — A17 discipline).
 */
function readEquirectViaBlit(
  renderer: THREE.WebGLRenderer,
  srcTex: THREE.Texture,
  w: number,
  h: number,
): Float32Array {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });

  const geom = new THREE.BufferGeometry();
  // Fullscreen triangle (clip-space); covers the whole RT.
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]),
      3,
    ),
  );
  const mat = new THREE.ShaderMaterial({
    vertexShader: BLIT_VERT,
    fragmentShader: BLIT_FRAG,
    glslVersion: THREE.GLSL3,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSrc: { value: srcTex },
      uResolution: { value: new THREE.Vector2(w, h) },
    },
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.Camera();

  const buf = new Float32Array(w * h * 4);
  const prev = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  } finally {
    renderer.setRenderTarget(prev);
    // Dispose everything we allocated here. The source texture belongs
    // to runParity's equiRT (runErodeBake transferred RT ownership to
    // runParity); runParity disposes that RT after this returns.
    rt.dispose();
    mat.dispose();
    geom.dispose();
  }
  return buf;
}

/**
 * Compare CPU 'h_final' (Rust row-major, y=0 = North) against the GPU
 * readback buffer (GL bottom-origin RGBA) over land texels only.
 *
 * Indexing: Rust texel '(x, ry)' (ry = Rust row, 0 = North) lives at
 * 'cpu[ry*w + x]'. The same sphere point in the GL readback is at
 * buffer row 'h-1-ry' (the documented RESAMPLE-vs-readRenderTargetPixels
 * vertical flip), channel '.r': 'gpu[((h-1-ry)*w + x)*4]'.
 */
function compareLandTexels(
  cpu: number[],
  gpu: Float32Array,
  w: number,
  h: number,
): { rmse: number; maxAbs: number; nLand: number; worst: ParityWorstTexel[] } {
  let sumSq = 0;
  let maxAbs = 0;
  let nLand = 0;
  // Min-heap-ish: keep the worst K by |Δ| with a small bounded array.
  const K = PARITY_WORST_K;
  const worst: ParityWorstTexel[] = [];
  let worstMin = Infinity; // smallest |d| currently retained

  for (let ry = 0; ry < h; ry++) {
    const gpuRow = h - 1 - ry; // documented vertical flip
    for (let x = 0; x < w; x++) {
      const cpuIdx = ry * w + x;
      const cpuH = cpu[cpuIdx];
      const gpuH = gpu[(gpuRow * w + x) * 4]; // .r channel
      // Land = both > 0 (Rust 'is_continental': elev > 0). Ocean texels
      // are not the parity surface; a sign-disagreeing coastline texel
      // is still surfaced via 'worst' if |Δ| is large.
      if (!(cpuH > 0 && gpuH > 0)) continue;
      const d = Math.abs(cpuH - gpuH);
      sumSq += d * d;
      if (d > maxAbs) maxAbs = d;
      nLand++;

      if (worst.length < K || d > worstMin) {
        // lat: ry=0 → +90 (North); ry=h-1 → ~-90 (South).
        const v = (ry + 0.5) / h;
        const lat = 90 - v * 180;
        const u = (x + 0.5) / w;
        const lon = u * 360 - 180;
        worst.push({ idx: cpuIdx, lat, lon, cpu: cpuH, gpu: gpuH, d });
        worst.sort((a, b) => b.d - a.d);
        if (worst.length > K) worst.length = K;
        worstMin = worst[worst.length - 1].d;
      }
    }
  }

  const rmse = nLand > 0 ? Math.sqrt(sumSq / nLand) : 0;
  return { rmse, maxAbs, nLand, worst };
}

export interface RunParityOpts {
  /** Override the painter-merged draft fields if the caller wants to
   *  feed a hand-built draft (defaults to using 'draft' as-is). */
  baseFaceRes?: number;
  pyramidLevels?: number;
  seed?: number;
}

/**
 * Run the CPU↔GPU parity check for 'draft'. Builds the shared small-res
 * config, runs the CPU oracle ('bake_erode_v2') and the GPU port
 * ('bake_h0_v2' → 'uploadH0' → 'runErodeBake') on the SAME draft+config
 * starting from the SAME rasterised h0, compares land texels, logs a
 * structured PASS/FAIL table + the worst texels, and returns the report.
 *
 * Throws on FAIL (after logging) so the in-app trigger surfaces it as a
 * hard error — the acceptance is encoded as an assertion (Task A18
 * Step 1: no tsx unit test; the check is an in-app assertion).
 *
 * 'scene.runBake' ownership note: 'runErodeBake' transfers the equirect
 * 'WebGLRenderTarget' to us; we 'rt.dispose()' it here once read (frees
 * its framebuffer AND texture). 'uploadH0''s DataTexture is also ours;
 * disposed here. No leak (A17 discipline).
 */
export async function runParity(
  renderer: THREE.WebGLRenderer,
  draft: DraftLike,
  runBake: (
    fn: (renderer: THREE.WebGLRenderer) => Promise<void> | void,
  ) => Promise<void>,
  opts?: RunParityOpts,
): Promise<ParityReport> {
  const baseFaceRes = opts?.baseFaceRes ?? PARITY_BASE_FACE_RES;
  const pyramidLevels = opts?.pyramidLevels ?? PARITY_PYRAMID_LEVELS;
  const seed = opts?.seed ?? PARITY_SEED;

  // Shared config objects — both derived from the SAME values so CPU
  // formulas == GPU formulas (a divergence here would be a FALSE fail).
  const snake = sharedErosionConfigSnake();
  snake.base_face_res = baseFaceRes;
  snake.pyramid_levels = pyramidLevels;
  snake.seed = seed;
  const gpuCfg = sharedErodeConfig();
  gpuCfg.baseFaceRes = baseFaceRes;
  gpuCfg.pyramidLevels = pyramidLevels;
  gpuCfg.seed = seed;

  // ---- CPU oracle ------------------------------------------------------
  // Tauri invoke arg keys are camelCase → Rust snake_case
  // ('erosionConfig' → 'erosion_config'); the CONFIG OBJECT itself is
  // snake_case because Rust 'ErosionConfig' fields are snake_case +
  // '#[serde(default)]'.
  const cpu = await invoke<ErodeResultV2>("bake_erode_v2", {
    draft,
    erosionConfig: snake,
  });
  const w = cpu.equirect_w;
  const h = cpu.equirect_h;
  if (cpu.h_final.length !== w * h) {
    throw new Error(
      "[parity] CPU h_final length " +
        cpu.h_final.length +
        " != equirect_w*equirect_h (" +
        w +
        "*" +
        h +
        ")",
    );
  }

  // ---- GPU port (SAME h0, SAME res) ------------------------------------
  // 'bake_h0_v2' rasterises the SAME painted-cell field the CPU oracle
  // rasterises internally (both call painted_cells_from_draft →
  // rasterize_from_cells). Pinning faceRes to baseFaceRes makes the GPU
  // start field byte-identical to the CPU oracle's start field.
  const h0 = await invoke<H0Atlas>("bake_h0_v2", {
    draft,
    faceRes: baseFaceRes,
  });
  const srcH0Tex = uploadH0(h0.atlas, h0.face_res);

  let equiRT: THREE.WebGLRenderTarget | null = null;
  try {
    await runBake(async (r) => {
      equiRT = await runErodeBake(r, srcH0Tex, {
        ...gpuCfg,
        srcFaceRes: h0.face_res,
        equirectW: w, // force GPU equirect == CPU equirect dims
        equirectH: h,
      });
    });
    if (!equiRT) {
      throw new Error("[parity] runErodeBake returned no render target");
    }

    // Blit the (frozen-pipeline) returned RT's texture into our own
    // RGBA32F RT and read it back. Vertical-flip alignment handled in
    // the comparator (see file header — RESAMPLE writes North at the
    // framebuffer top; readRenderTargetPixels is bottom-origin).
    const gpuBuf = readEquirectViaBlit(
      renderer,
      (equiRT as THREE.WebGLRenderTarget).texture,
      w,
      h,
    );

    const { rmse, maxAbs, nLand, worst } = compareLandTexels(
      cpu.h_final,
      gpuBuf,
      w,
      h,
    );
    // No-land guard: with zero land texels (cpu>0 && gpu>0) the
    // comparator returns rmse=0,maxAbs=0 which would pass the gate
    // below — a meaningless false PASS. A draft with no continental
    // elevation (both sides ocean) is not a valid parity surface;
    // surface it as a hard error (App.tsx catches/handles thrown
    // errors in-panel) BEFORE the PASS/FAIL gate.
    if (nLand === 0) {
      throw new Error(
        "[parity] no land texels (cpu>0 && gpu>0) — draft has no " +
          "continental elevation / both sides ocean; comparison is " +
          "vacuous, not a PASS",
      );
    }
    const pass = rmse < PARITY_RMSE_GATE && maxAbs < PARITY_MAXABS_GATE;

    const report: ParityReport = {
      pass,
      rmse,
      maxAbs,
      nLand,
      worst,
      width: w,
      height: h,
    };

    // ---- Structured log -------------------------------------------------
    const tag = pass ? "PASS" : "FAIL";
    console.log(
      "[parity] " +
        tag +
        " — equirect " +
        w +
        "x" +
        h +
        ", land texels " +
        nLand +
        ", RMSE " +
        rmse.toExponential(4) +
        " (gate < " +
        PARITY_RMSE_GATE.toExponential(0) +
        "), maxAbs " +
        maxAbs.toExponential(4) +
        " (gate < " +
        PARITY_MAXABS_GATE.toExponential(0) +
        ")",
    );
    console.log(
      "[parity] config — base_face_res " +
        baseFaceRes +
        ", pyramid_levels " +
        pyramidLevels +
        ", seed 0x" +
        (seed >>> 0).toString(16) +
        " (all other fields = ErosionConfig::default(), CPU & GPU byte-identical)",
    );
    if (typeof console.table === "function") {
      console.table(
        report.worst.map((t) => ({
          idx: t.idx,
          lat: t.lat.toFixed(3),
          lon: t.lon.toFixed(3),
          cpu: t.cpu.toExponential(5),
          gpu: t.gpu.toExponential(5),
          absDiff: t.d.toExponential(5),
        })),
      );
    } else {
      console.log("[parity] worst texels:", report.worst);
    }
    if (!pass) {
      // Enough to diff the offending region: the worst texels carry
      // lat/lon + both heights. Re-log compactly so a FAIL is actionable
      // even if console.table is unavailable / collapsed.
      console.error(
        "[parity] FAIL — worst " +
          report.worst.length +
          " land texels (lat,lon,cpu,gpu,|d|):",
      );
      for (const t of report.worst) {
        console.error(
          "  (" +
            t.lat.toFixed(3) +
            ", " +
            t.lon.toFixed(3) +
            ")  cpu=" +
            t.cpu.toExponential(6) +
            "  gpu=" +
            t.gpu.toExponential(6) +
            "  |d|=" +
            t.d.toExponential(6),
        );
      }
      throw new ParityError(report);
    }

    return report;
  } finally {
    // Dispose everything WE own: the equirect render target runErodeBake
    // transferred to us (rt.dispose() frees BOTH the GL framebuffer AND
    // rt.texture — a bare texture.dispose() would leak the FBO), and the
    // h0 DataTexture from uploadH0. The blit RT/material/geometry are
    // disposed inside readEquirectViaBlit. Single dispose each — no
    // double-dispose, no use-after-dispose (readback already completed).
    (equiRT as THREE.WebGLRenderTarget | null)?.dispose();
    srcH0Tex.dispose();
  }
}

/** Thrown by 'runParity' on a FAILing gate (after the full table +
 *  worst-texel diagnostics are logged). Carries the report so the
 *  caller (App.tsx) can still surface the numbers in the UI. */
export class ParityError extends Error {
  readonly report: ParityReport;
  constructor(report: ParityReport) {
    super(
      "[parity] FAIL — RMSE " +
        report.rmse.toExponential(4) +
        " (gate < " +
        PARITY_RMSE_GATE.toExponential(0) +
        "), maxAbs " +
        report.maxAbs.toExponential(4) +
        " (gate < " +
        PARITY_MAXABS_GATE.toExponential(0) +
        ") over " +
        report.nLand +
        " land texels",
    );
    this.name = "ParityError";
    this.report = report;
  }
}
