// DEV / HEADLESS VERIFICATION HARNESS — NOT shipped, NOT imported by the app.
// =============================================================================
// Purpose: execute the REAL hydraulic erosion sim core (runHydraulicBake) on a
// real WebGL2 context, headlessly, with SYNTHESIZED equirect inputs (no Tauri),
// and numerically gate the catastrophic failure modes from the erosion saga:
//   feedback-loop / INVALID_OPERATION / context-loss, NaN/Inf, degenerate-zero
//   field, ocean-not-preserved, longitude-seam break, poles-not-damped.
//
// This file is intentionally framework-free and side-effect-free on import:
// `runHeadlessErosionVerification(renderer?)` is called explicitly by a dev
// page or a Playwright `browser_evaluate` shim (it dynamically imports the
// sim modules from the Vite dev server). It does NOT replace the user's
// Task-8 aesthetic/orientation visual judgement — it only proves the pipeline
// runs cleanly on a real GL context and the field is sane / non-degenerate.
//
// HOW TO RUN (Playwright / Chromium headless, SwiftShader or real ANGLE):
//   1. `npm run dev` in apps/hayba-explorer (Vite, port 5184).
//   2. Navigate Chromium to http://127.0.0.1:5184/.
//   3. In-page: `await import('/src/viewport/bake/__headless_harness__.ts')`
//      then `await m.runHeadlessErosionVerification()` and inspect the JSON.
//
// FINDING (2026-05-16, NVIDIA RTX 5070 / ANGLE-D3D11, real GPU, WebGL2):
//   The pipeline executes with ZERO WebGL/console errors and produces a
//   FINITE field (0 NaN / 0 Inf), BUT the field is DEGENERATE: after the
//   first sim step the terrain-height channel (A.r) and the ocean flag (A.a)
//   collapse to ~0 while only the water channel (A.g) updates correctly. The
//   ocean is consequently destroyed. Reproduced deterministically at
//   8x4..256x128. SEED-only (steps:0) is perfect, so the regression is in the
//   sim-step passes, not input upload / seed / readback. See the report for
//   the per-pass isolation. This is the saga's "degenerate-zero-field +
//   ocean-lost" catastrophic mode and would hit the user's Task-8 run.
// =============================================================================

import * as THREE from "three";

export interface ErosionVerifyResult {
  ran: boolean;
  error?: string;
  isWebGL2?: boolean;
  unmaskedRenderer?: string;
  ext_color_buffer_float?: boolean;
  oes_texture_float_linear?: boolean;
  ms?: number;
  webglErrPre?: number;
  webglErrPost?: number;
  consoleErrs?: string[];
  grid?: { w: number; h: number; nLand: number; nOcean: number };
  verify?: {
    nan: number;
    inf: number;
    minB: number;
    maxB: number;
    landTotal: number;
    landChangedPct: number;
    oceanTotal: number;
    oceanLost_bGE0: number;
    oceanFlagKept: number;
    seamMean: number;
    interiorMean: number;
    seamRatio: number;
    topMaxAbsD: number;
    botMaxAbsD: number;
  };
  // Core PASS/FAIL gate for the catastrophic modes (NOT the aesthetic gate).
  corePass?: boolean;
  coreReasons?: string[];
}

/** Synthesize a deterministic test "continent": an elevated smooth dome
 *  (land, b in ~0.03..0.8) over deep ocean (b = -1.0). Guarantees BOTH
 *  land>0 and ocean<0 texels; precip is a wetter-equator lat band. */
function synthContinent(
  w: number,
  h: number,
): { base: Float32Array; precip: Float32Array; nLand: number; nOcean: number } {
  const base = new Float32Array(w * h);
  const precip = new Float32Array(w * h);
  const cx = w * 0.45,
    cy = h * 0.5,
    rx = w * 0.28,
    ry = h * 0.34;
  let nLand = 0,
    nOcean = 0;
  for (let y = 0; y < h; y++) {
    const latFrac = (y + 0.5) / h; // 0 = North row .. 1 = South row
    const lat = (0.5 - latFrac) * Math.PI;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let dx = x - cx;
      if (dx > w / 2) dx -= w;
      if (dx < -w / 2) dx += w;
      const d = Math.sqrt((dx / rx) ** 2 + ((y - cy) / ry) ** 2);
      if (d < 1.0) {
        const dome = 0.8 * (Math.cos(d * Math.PI) * 0.5 + 0.5);
        const bump = 0.06 * Math.sin(x * 0.21) * Math.cos(y * 0.27);
        base[i] = Math.max(0.03, dome + bump);
        nLand++;
      } else {
        base[i] = -1.0;
        nOcean++;
      }
      precip[i] = 0.4 + 0.6 * Math.cos(lat) * Math.cos(lat);
    }
  }
  return { base, precip, nLand, nOcean };
}

// =============================================================================
// REAL-INPUT verification — fetch the byte-for-byte serde JSON the real Rust
// `bake_inputs_equirect_impl` produced for a representative DEM-like
// multi-continent draft (apps/hayba-explorer/public/erosion_real_inputs.json,
// written by the `write_real_equirect_inputs_fixture` Rust test) and run the
// REAL `runHydraulicBake` on it with discriminating metrics that pinpoint the
// user's "sea erodes, land doesn't" symptom.
// =============================================================================

export interface RealErosionVerifyResult extends ErosionVerifyResult {
  source?: "real_inputs_json";
  realStats?: {
    w: number;
    h: number;
    // Truth derived from the REAL base height (NOT the seeded A.a flag):
    trueOcean: number; // base < 0
    trueLand: number; // base > 0
    // SEED's A.a flag count vs the true ocean count (mismatch => flag bug).
    seedOceanFlag: number;
    seedOceanFlagMatchesTrue: boolean;
    // THE discriminating metrics for this bug:
    oceanBigDeltaPct: number; // % ocean texels |Δb|>thr  (BUG: should be ~0)
    landBigDeltaPct: number; // % land texels |Δb|>thr   (BUG: should be high)
    oceanMeanAbsDelta: number;
    landMeanAbsDelta: number;
    oceanMaxAbsDelta: number;
    landMaxAbsDelta: number;
    deltaThreshold: number;
    symptomReproduced: boolean; // ocean Δ >> land Δ (the user's bug)
  };
}

/** Fetch the real serde JSON, wrap exactly as App.tsx does, run the REAL
 *  hydraulic bake on the real GPU, and compute metrics that DISCRIMINATE
 *  "ocean erodes / land doesn't" from a healthy run. */
export async function runRealInputErosionVerification(
  injectedRenderer?: THREE.WebGLRenderer,
  overrideCfg?: Record<string, number>,
): Promise<RealErosionVerifyResult> {
  const consoleErrs: string[] = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => {
    consoleErrs.push("ERR " + a.map(String).join(" "));
    origErr.apply(console, a as []);
  };
  console.warn = (...a: unknown[]) => {
    consoleErrs.push("WARN " + a.map(String).join(" "));
    origWarn.apply(console, a as []);
  };
  try {
    const hyd = await import("./hydraulic");
    const eq = await import("./equirectInput");
    const gp = await import("./glPass");

    const resp = await fetch("/erosion_real_inputs.json");
    if (!resp.ok)
      throw new Error(
        `fetch /erosion_real_inputs.json -> ${resp.status}; run the ` +
          `write_real_equirect_inputs_fixture Rust test first`,
      );
    const inp = (await resp.json()) as {
      w: number;
      h: number;
      height: number[];
      precip: number[];
    };
    const w = inp.w;
    const h = inp.h;
    if (inp.height.length !== w * h || inp.precip.length !== w * h)
      throw new Error("real_inputs.json length mismatch");

    // EXACTLY App.tsx's wrap: `new Float32Array(inp.height)`.
    const baseArr = new Float32Array(inp.height);
    const precipArr = new Float32Array(inp.precip);

    let renderer = injectedRenderer;
    if (!renderer) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    }
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const isWebGL2 =
      typeof WebGL2RenderingContext !== "undefined" &&
      gl instanceof WebGL2RenderingContext;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const unmaskedRenderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : "n/a";
    const ext_color_buffer_float =
      gl.getExtension("EXT_color_buffer_float") != null;
    const oes_texture_float_linear =
      gl.getExtension("OES_texture_float_linear") != null;
    if (!ext_color_buffer_float) {
      console.error = origErr;
      console.warn = origWarn;
      return {
        ran: false,
        error: "EXT_color_buffer_float ABSENT — need a real GPU",
        isWebGL2,
        unmaskedRenderer,
        ext_color_buffer_float,
        oes_texture_float_linear,
        consoleErrs,
        source: "real_inputs_json",
      };
    }

    const baseTex = eq.uploadEquirect(baseArr, w, h);
    const precipTex = eq.uploadEquirect(precipArr, w, h);
    const cfg = { ...hyd.DEFAULT_HYDRAULIC, ...(overrideCfg ?? {}) };

    const webglErrPre = gl.getError();
    const t0 = performance.now();
    const rt = await hyd.runHydraulicBake(
      renderer,
      baseTex,
      precipTex,
      w,
      h,
      cfg,
    );
    const t1 = performance.now();
    const webglErrPost = gl.getError();

    const buf = new Float32Array(w * h * 4);
    gp.readRawPixels(renderer, rt, 0, 0, w, h, buf);

    const THR = 1e-3; // "meaningful" |Δb| for land-erosion / ocean-preserve
    let nan = 0,
      inf = 0,
      minB = Infinity,
      maxB = -Infinity;
    let trueOcean = 0,
      trueLand = 0,
      seedOceanFlag = 0;
    let oceanBig = 0,
      landBig = 0,
      oceanAbsSum = 0,
      landAbsSum = 0,
      oceanMax = 0,
      landMax = 0;
    let oceanLost = 0,
      oceanFlagKept = 0;
    for (let i = 0; i < w * h; i++) {
      const bF = buf[i * 4];
      const aFlag = buf[i * 4 + 3];
      const bB = baseArr[i];
      if (Number.isNaN(bF)) nan++;
      else if (!Number.isFinite(bF)) inf++;
      if (Number.isFinite(bF)) {
        if (bF < minB) minB = bF;
        if (bF > maxB) maxB = bF;
      }
      if (aFlag > 0.5) seedOceanFlag++;
      const dAbs = Number.isFinite(bF) ? Math.abs(bF - bB) : 0;
      if (bB < 0) {
        trueOcean++;
        oceanAbsSum += dAbs;
        if (dAbs > oceanMax) oceanMax = dAbs;
        if (dAbs > THR) oceanBig++;
        if (bF >= 0) oceanLost++;
        if (aFlag > 0.5) oceanFlagKept++;
      } else if (bB > 0) {
        trueLand++;
        landAbsSum += dAbs;
        if (dAbs > landMax) landMax = dAbs;
        if (dAbs > THR) landBig++;
      }
    }
    const oceanBigPct = +((100 * oceanBig) / Math.max(1, trueOcean)).toFixed(2);
    const landBigPct = +((100 * landBig) / Math.max(1, trueLand)).toFixed(2);
    const oceanMeanAbs = +(oceanAbsSum / Math.max(1, trueOcean)).toFixed(7);
    const landMeanAbs = +(landAbsSum / Math.max(1, trueLand)).toFixed(7);
    // The user's symptom: ocean is being heavily eroded while land barely
    // moves — i.e. ocean Δ is large AND noticeably exceeds land Δ.
    const symptomReproduced =
      oceanBigPct > 5 && oceanMeanAbs > landMeanAbs * 1.2;

    const reasons: string[] = [];
    if (webglErrPost !== 0 || consoleErrs.length > 0)
      reasons.push("WebGL/console errors");
    if (nan > 0 || inf > 0) reasons.push("NaN/Inf in field");
    if (maxB < 0.01) reasons.push("DEGENERATE: field collapsed (maxB<0.01)");
    if (landBigPct < 5)
      reasons.push(`erosion no-op on LAND (<5%: ${landBigPct}%)`);
    if (oceanBigPct > 5)
      reasons.push(`OCEAN ERODED (>5% ocean |Δb|>1e-3: ${oceanBigPct}%)`);
    if (oceanLost / Math.max(1, trueOcean) > 0.05)
      reasons.push("ocean rose to b>=0");
    if (oceanFlagKept / Math.max(1, trueOcean) < 0.5)
      reasons.push("ocean flag (A.a) not preserved vs true ocean");
    const corePass = reasons.length === 0;

    console.error = origErr;
    console.warn = origWarn;
    return {
      ran: true,
      source: "real_inputs_json",
      isWebGL2,
      unmaskedRenderer,
      ext_color_buffer_float,
      oes_texture_float_linear,
      ms: Math.round(t1 - t0),
      webglErrPre,
      webglErrPost,
      consoleErrs,
      grid: { w, h, nLand: trueLand, nOcean: trueOcean },
      verify: {
        nan,
        inf,
        minB: +minB.toFixed(5),
        maxB: +maxB.toFixed(5),
        landTotal: trueLand,
        landChangedPct: landBigPct,
        oceanTotal: trueOcean,
        oceanLost_bGE0: oceanLost,
        oceanFlagKept,
        seamMean: 0,
        interiorMean: 0,
        seamRatio: 0,
        topMaxAbsD: 0,
        botMaxAbsD: 0,
      },
      realStats: {
        w,
        h,
        trueOcean,
        trueLand,
        seedOceanFlag,
        seedOceanFlagMatchesTrue:
          Math.abs(seedOceanFlag - trueOcean) <= Math.max(1, trueOcean * 0.01),
        oceanBigDeltaPct: oceanBigPct,
        landBigDeltaPct: landBigPct,
        oceanMeanAbsDelta: oceanMeanAbs,
        landMeanAbsDelta: landMeanAbs,
        oceanMaxAbsDelta: +oceanMax.toFixed(6),
        landMaxAbsDelta: +landMax.toFixed(6),
        deltaThreshold: THR,
        symptomReproduced,
      },
      corePass,
      coreReasons: reasons,
    };
  } catch (e) {
    console.error = origErr;
    console.warn = origWarn;
    return {
      ran: false,
      error: String(e),
      consoleErrs,
      source: "real_inputs_json",
    };
  }
}

/**
 * Execute the real sim and numerically gate the catastrophic modes.
 * Returns a JSON-able result; throws nothing (errors are captured).
 */
export async function runHeadlessErosionVerification(
  injectedRenderer?: THREE.WebGLRenderer,
): Promise<ErosionVerifyResult> {
  const consoleErrs: string[] = [];
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => {
    consoleErrs.push("ERR " + a.map(String).join(" "));
    origErr.apply(console, a as []);
  };
  console.warn = (...a: unknown[]) => {
    consoleErrs.push("WARN " + a.map(String).join(" "));
    origWarn.apply(console, a as []);
  };
  try {
    const hyd = await import("./hydraulic");
    const eq = await import("./equirectInput");
    const gp = await import("./glPass");

    const w = 256,
      h = 128;
    const { base, precip, nLand, nOcean } = synthContinent(w, h);

    let renderer = injectedRenderer;
    if (!renderer) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    }
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const isWebGL2 =
      typeof WebGL2RenderingContext !== "undefined" &&
      gl instanceof WebGL2RenderingContext;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const unmaskedRenderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : "n/a";
    const ext_color_buffer_float =
      gl.getExtension("EXT_color_buffer_float") != null;
    const oes_texture_float_linear =
      gl.getExtension("OES_texture_float_linear") != null;

    if (!ext_color_buffer_float) {
      console.error = origErr;
      console.warn = origWarn;
      return {
        ran: false,
        error:
          "EXT_color_buffer_float ABSENT — RGBA32F render targets impossible " +
          "in this headless GL. Task-8 still needs the user's real GPU.",
        isWebGL2,
        unmaskedRenderer,
        ext_color_buffer_float,
        oes_texture_float_linear,
        consoleErrs,
      };
    }

    const baseTex = eq.uploadEquirect(base, w, h);
    const precipTex = eq.uploadEquirect(precip, w, h);
    const cfg = { ...hyd.DEFAULT_HYDRAULIC, steps: 60, chunk: 16 };

    const webglErrPre = gl.getError();
    const t0 = performance.now();
    const rt = await hyd.runHydraulicBake(
      renderer,
      baseTex,
      precipTex,
      w,
      h,
      cfg,
    );
    const t1 = performance.now();
    const webglErrPost = gl.getError();

    const buf = new Float32Array(w * h * 4);
    gp.readRawPixels(renderer, rt, 0, 0, w, h, buf);

    let nan = 0,
      inf = 0,
      minB = Infinity,
      maxB = -Infinity,
      landChanged = 0,
      landTotal = 0,
      oceanTotal = 0,
      oceanLost = 0,
      oceanFlagKept = 0;
    for (let i = 0; i < w * h; i++) {
      const bF = buf[i * 4];
      const of = buf[i * 4 + 3];
      const bB = base[i];
      if (Number.isNaN(bF)) nan++;
      else if (!Number.isFinite(bF)) inf++;
      if (Number.isFinite(bF)) {
        if (bF < minB) minB = bF;
        if (bF > maxB) maxB = bF;
      }
      if (bB > 0) {
        landTotal++;
        if (Math.abs(bF - bB) > 1e-4) landChanged++;
      } else {
        oceanTotal++;
        if (bF >= 0) oceanLost++;
        if (of > 0.5) oceanFlagKept++;
      }
    }
    let seamS = 0,
      seamN = 0,
      intS = 0,
      intN = 0;
    for (let y = 0; y < h; y++) {
      const a0 = buf[y * w * 4];
      const aW = buf[(y * w + w - 1) * 4];
      if (Number.isFinite(a0) && Number.isFinite(aW)) {
        seamS += Math.abs(a0 - aW);
        seamN++;
      }
      for (let x = 0; x < w - 1; x += 7) {
        const p = buf[(y * w + x) * 4];
        const q = buf[(y * w + x + 1) * 4];
        if (Number.isFinite(p) && Number.isFinite(q)) {
          intS += Math.abs(p - q);
          intN++;
        }
      }
    }
    let topMaxAbsD = 0,
      botMaxAbsD = 0;
    for (let x = 0; x < w; x++) {
      topMaxAbsD = Math.max(topMaxAbsD, Math.abs(buf[x * 4] - base[x]));
      botMaxAbsD = Math.max(
        botMaxAbsD,
        Math.abs(buf[((h - 1) * w + x) * 4] - base[(h - 1) * w + x]),
      );
    }
    const seamMean = seamN ? seamS / seamN : 0;
    const interiorMean = intN ? intS / intN : 0;
    const seamRatio = interiorMean ? seamMean / interiorMean : Infinity;

    // Core catastrophic-mode gate (NOT the aesthetic gate).
    const reasons: string[] = [];
    if (webglErrPost !== 0 || consoleErrs.length > 0)
      reasons.push("WebGL/console errors (incl. possible feedback-loop)");
    if (nan > 0 || inf > 0) reasons.push("NaN/Inf in field");
    if (maxB < 0.01)
      reasons.push("DEGENERATE: field collapsed to ~0 (maxB<0.01)");
    if (landChanged / Math.max(1, landTotal) < 0.05)
      reasons.push("erosion no-op (<5% land changed)");
    if (oceanLost / Math.max(1, oceanTotal) > 0.05)
      reasons.push("OCEAN LOST (>5% ocean texels b>=0)");
    if (oceanFlagKept / Math.max(1, oceanTotal) < 0.5)
      reasons.push("ocean flag (A.a) not preserved");
    if (seamRatio > 5)
      reasons.push("longitude SEAM break (seam/interior > 5x)");
    const corePass = reasons.length === 0;

    console.error = origErr;
    console.warn = origWarn;
    return {
      ran: true,
      isWebGL2,
      unmaskedRenderer,
      ext_color_buffer_float,
      oes_texture_float_linear,
      ms: Math.round(t1 - t0),
      webglErrPre,
      webglErrPost,
      consoleErrs,
      grid: { w, h, nLand, nOcean },
      verify: {
        nan,
        inf,
        minB: +minB.toFixed(5),
        maxB: +maxB.toFixed(5),
        landTotal,
        landChangedPct: +((100 * landChanged) / Math.max(1, landTotal)).toFixed(
          2,
        ),
        oceanTotal,
        oceanLost_bGE0: oceanLost,
        oceanFlagKept,
        seamMean: +seamMean.toFixed(7),
        interiorMean: +interiorMean.toFixed(7),
        seamRatio: +seamRatio.toFixed(2),
        topMaxAbsD: +topMaxAbsD.toFixed(6),
        botMaxAbsD: +botMaxAbsD.toFixed(6),
      },
      corePass,
      coreReasons: reasons,
    };
  } catch (e) {
    console.error = origErr;
    console.warn = origWarn;
    return {
      ran: false,
      error: String(e),
      consoleErrs,
    };
  }
}

// =============================================================================
// VISUAL ORACLE (dev only) — render the eroded equirect field to hillshaded
// hypsometric relief + a signed before/after DELTA image, so a checkpoint can
// be judged BY EYE headlessly (no Tauri). The numeric verifier above proves the
// pipeline is sane; this answers the aesthetic CP0 questions: does the macro
// continent silhouette survive, are interior valleys dendritic (not ring-basin
// planed), and is there a rim "moat" at the massif base? Returns base64 PNG
// data-URLs; the driver writes them to disk and a human/agent inspects them.
// =============================================================================

interface ReliefOpts {
  exaggeration?: number;
  scale?: number;
  mode?: "relief" | "delta";
  ref?: Float32Array;
}

/** Hypsometric land ramp: lowland green → tan → brown → grey rock → snow. */
function hypso(t: number): [number, number, number] {
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [60, 110, 50]],
    [0.25, [120, 150, 70]],
    [0.5, [170, 150, 110]],
    [0.72, [140, 110, 85]],
    [0.88, [150, 150, 150]],
    [1.0, [245, 245, 250]],
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let s = 0; s < stops.length - 1; s++) {
    if (t >= stops[s][0] && t <= stops[s + 1][0]) {
      a = stops[s];
      b = stops[s + 1];
      break;
    }
  }
  const f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  return [
    a[1][0] + (b[1][0] - a[1][0]) * f,
    a[1][1] + (b[1][1] - a[1][1]) * f,
    a[1][2] + (b[1][2] - a[1][2]) * f,
  ];
}

/** Render an equirect height field to a (scale×) PNG data-URL. `relief` =
 *  hillshaded hypsometric; `delta` = signed (after-ref) diverging colormap
 *  (warm = carved DOWN, cool = raised) — moats/incision pop instantly. */
function fieldToReliefDataURL(
  field: Float32Array,
  w: number,
  h: number,
  opts: ReliefOpts = {},
): string {
  const scale = opts.scale ?? 4;
  const exg = opts.exaggeration ?? 1.0;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext("2d")!;
  const img = ctx.createImageData(w, h);

  let landMax = 1e-6;
  for (let i = 0; i < w * h; i++) if (field[i] > landMax) landMax = field[i];

  const at = (x: number, y: number): number => {
    const xx = ((x % w) + w) % w; // wrap longitude
    const yy = Math.min(h - 1, Math.max(0, y));
    return field[yy * w + xx];
  };

  if (opts.mode === "delta" && opts.ref) {
    const ref = opts.ref;
    const ds: number[] = [];
    for (let i = 0; i < w * h; i++)
      if (ref[i] > 0 || field[i] > 0) ds.push(Math.abs(field[i] - ref[i]));
    ds.sort((p, q) => p - q);
    const dmax = Math.max(1e-5, ds[Math.floor(ds.length * 0.98)] || 1e-5);
    for (let i = 0; i < w * h; i++) {
      const land = ref[i] > 0 || field[i] > 0;
      let r = 18,
        g = 22,
        b = 30;
      if (land) {
        const t = Math.max(-1, Math.min(1, (field[i] - ref[i]) / dmax));
        if (t < 0) {
          r = 255;
          g = Math.round(245 * (1 + t));
          b = Math.round(110 * (1 + t));
        } else {
          r = Math.round(110 * (1 - t));
          g = Math.round(200 * (1 - t));
          b = 255;
        }
      }
      const o = i * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  } else {
    const ae = Math.PI * 0.25;
    const el = Math.PI * 0.3;
    const sun = [
      Math.cos(el) * Math.cos(ae),
      Math.cos(el) * Math.sin(ae),
      Math.sin(el),
    ];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const z = field[i];
        let r: number, g: number, b: number;
        if (z < 0) {
          const t = Math.max(0, Math.min(1, 1 + z)); // -1..0 → 0..1
          r = 12 + 40 * t;
          g = 28 + 70 * t;
          b = 70 + 120 * t;
        } else {
          const c = hypso(Math.max(0, Math.min(1, z / landMax)));
          const dzdx = (at(x + 1, y) - at(x - 1, y)) * exg * 0.5;
          const dzdy = (at(x, y + 1) - at(x, y - 1)) * exg * 0.5;
          let nx = -dzdx,
            ny = -dzdy,
            nz = 1.0;
          const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
          nx *= il;
          ny *= il;
          nz *= il;
          let sh = nx * sun[0] + ny * sun[1] + nz * sun[2];
          sh = Math.max(0.25, Math.min(1.15, 0.55 + 0.75 * sh));
          r = Math.min(255, c[0] * sh);
          g = Math.min(255, c[1] * sh);
          b = Math.min(255, c[2] * sh);
        }
        const o = i * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  const out = document.createElement("canvas");
  out.width = w * scale;
  out.height = h * scale;
  const octx = out.getContext("2d")!;
  octx.imageSmoothingEnabled = false;
  octx.drawImage(cv, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/** Extract a longitude-wrapping sub-rect and render it (zoom crop). */
function cropReliefDataURL(
  field: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  cw: number,
  ch: number,
  opts: ReliefOpts = {},
): string {
  const sub = new Float32Array(cw * ch);
  const refSub = opts.ref ? new Float32Array(cw * ch) : undefined;
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const sx = (((cx + x) % w) + w) % w;
      const sy = Math.min(h - 1, Math.max(0, cy + y));
      sub[y * cw + x] = field[sy * w + sx];
      if (refSub && opts.ref) refSub[y * cw + x] = opts.ref[sy * w + sx];
    }
  return fieldToReliefDataURL(sub, cw, ch, { ...opts, ref: refSub });
}

export interface ErosionReliefResult {
  ran: boolean;
  error?: string;
  unmaskedRenderer?: string;
  ms?: number;
  w?: number;
  h?: number;
  consoleErrs?: string[];
  stats?: {
    minB: number;
    maxB: number;
    landChangedPct: number;
    oceanLost: number;
    /** mean |Δ| in a thin annulus just inside each massif coastline vs the
     *  deep interior — a moat shows as rim≫interior. */
    rimMeanAbsDelta: number;
    interiorMeanAbsDelta: number;
    moatRatio: number;
  };
  images?: {
    before: string; // hillshade, pre-erosion
    after: string; // hillshade, post-erosion
    delta: string; // signed after-before
    afterZoom: string; // dominant-massif crop, post-erosion
    deltaZoom: string; // dominant-massif crop, signed delta
  };
}

/** Real-GPU bake on the DEM-like multi-continent fixture, then emit relief +
 *  delta PNGs (full + dominant-massif zoom) and a numeric moat metric. The
 *  reusable eyes-on oracle for CP0.a … CP0.GATE. */
export async function runRealInputErosionRelief(
  injectedRenderer?: THREE.WebGLRenderer,
  overrideCfg?: Record<string, number>,
): Promise<ErosionReliefResult> {
  const consoleErrs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => {
    consoleErrs.push("ERR " + a.map(String).join(" "));
    origErr.apply(console, a as []);
  };
  try {
    const hyd = await import("./hydraulic");
    const eq = await import("./equirectInput");
    const gp = await import("./glPass");

    const resp = await fetch("/erosion_real_inputs.json");
    if (!resp.ok)
      throw new Error(
        `fetch /erosion_real_inputs.json -> ${resp.status}; run the ` +
          `write_real_equirect_inputs_fixture Rust test first`,
      );
    const inp = (await resp.json()) as {
      w: number;
      h: number;
      height: number[];
      precip: number[];
    };
    const w = inp.w;
    const h = inp.h;
    const baseArr = new Float32Array(inp.height);
    const precipArr = new Float32Array(inp.precip);

    const r = await _bakeAndRenderRelief(
      hyd,
      eq,
      gp,
      baseArr,
      precipArr,
      w,
      h,
      overrideCfg,
      injectedRenderer,
    );
    console.error = origErr;
    r.consoleErrs = consoleErrs;
    return r;
  } catch (e) {
    console.error = origErr;
    return { ran: false, error: String(e), consoleErrs };
  }
}

/** Shared: bake an equirect base/precip field on a real GPU and emit the
 *  relief + delta PNGs and the moat metric. Caller owns console capture. */
async function _bakeAndRenderRelief(
  hyd: typeof import("./hydraulic"),
  eq: typeof import("./equirectInput"),
  gp: typeof import("./glPass"),
  baseArr: Float32Array,
  precipArr: Float32Array,
  w: number,
  h: number,
  overrideCfg?: Record<string, number>,
  injectedRenderer?: THREE.WebGLRenderer,
): Promise<ErosionReliefResult> {
  let renderer = injectedRenderer;
  if (!renderer) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  }
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const unmaskedRenderer = dbg
    ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    : "n/a";
  if (gl.getExtension("EXT_color_buffer_float") == null) {
    return {
      ran: false,
      error: "EXT_color_buffer_float ABSENT — need a real GPU (not SwiftShader)",
      unmaskedRenderer,
      consoleErrs: [],
    };
  }

  const baseTex = eq.uploadEquirect(baseArr, w, h);
  const precipTex = eq.uploadEquirect(precipArr, w, h);
  const cfg = { ...hyd.DEFAULT_HYDRAULIC, ...(overrideCfg ?? {}) };

  const t0 = performance.now();
  const rt = await hyd.runHydraulicBake(renderer, baseTex, precipTex, w, h, cfg);
  const t1 = performance.now();

  const buf = new Float32Array(w * h * 4);
  gp.readRawPixels(renderer, rt, 0, 0, w, h, buf);
  const eroded = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) eroded[i] = buf[i * 4];

  // Moat metric: |Δ| in a thin coastal annulus ("rim", ≤2 px from ocean) vs
  // deep-interior land (>4 px from any ocean). moatRatio ≫ 1.5 ⇒ a coastal
  // erosion moat; ≪ 1 ⇒ rim spared, interior carved (the desired regime).
  let minB = Infinity,
    maxB = -Infinity,
    landChanged = 0,
    landTotal = 0,
    oceanLost = 0;
  let rimSum = 0,
    rimN = 0,
    intSum = 0,
    intN = 0;
  const isOcean = (x: number, y: number) =>
    baseArr[Math.min(h - 1, Math.max(0, y)) * w + (((x % w) + w) % w)] < 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const bF = eroded[i];
      const bB = baseArr[i];
      if (Number.isFinite(bF)) {
        if (bF < minB) minB = bF;
        if (bF > maxB) maxB = bF;
      }
      if (bB > 0) {
        landTotal++;
        const d = Math.abs(bF - bB);
        if (d > 1e-4) landChanged++;
        let nearCoast = false;
        for (let r = 1; r <= 2 && !nearCoast; r++)
          if (
            isOcean(x + r, y) ||
            isOcean(x - r, y) ||
            isOcean(x, y + r) ||
            isOcean(x, y - r)
          )
            nearCoast = true;
        if (nearCoast) {
          rimSum += d;
          rimN++;
        } else {
          let deep = true;
          for (let r = 1; r <= 4 && deep; r++)
            if (
              isOcean(x + r, y) ||
              isOcean(x - r, y) ||
              isOcean(x, y + r) ||
              isOcean(x, y - r)
            )
              deep = false;
          if (deep) {
            intSum += d;
            intN++;
          }
        }
      } else if (bB < 0 && bF >= 0) oceanLost++;
    }
  }
  const rimMean = rimN ? rimSum / rimN : 0;
  const intMean = intN ? intSum / intN : 0;

  // Dominant massif (continent 0: lon 40, lat 45, rlon 70, rlat 32).
  const cx = Math.round(((40 + 180) / 360) * w) - Math.round((70 / 360) * w);
  const cy = Math.round(((90 - 45) / 180) * h) - Math.round((32 / 180) * h);
  const cw = Math.min(w, Math.round((140 / 360) * w));
  const ch = Math.min(h, Math.round((68 / 180) * h));

  return {
    ran: true,
    unmaskedRenderer,
    ms: Math.round(t1 - t0),
    w,
    h,
    consoleErrs: [],
    stats: {
      minB: +minB.toFixed(5),
      maxB: +maxB.toFixed(5),
      landChangedPct: +((100 * landChanged) / Math.max(1, landTotal)).toFixed(2),
      oceanLost,
      rimMeanAbsDelta: +rimMean.toFixed(6),
      interiorMeanAbsDelta: +intMean.toFixed(6),
      moatRatio: +(rimMean / Math.max(1e-7, intMean)).toFixed(3),
    },
    images: {
      before: fieldToReliefDataURL(baseArr, w, h, { exaggeration: 6 }),
      after: fieldToReliefDataURL(eroded, w, h, { exaggeration: 6 }),
      delta: fieldToReliefDataURL(eroded, w, h, { mode: "delta", ref: baseArr }),
      afterZoom: cropReliefDataURL(eroded, w, h, cx, cy, cw, ch, {
        exaggeration: 7,
        scale: 8,
      }),
      deltaZoom: cropReliefDataURL(eroded, w, h, cx, cy, cw, ch, {
        mode: "delta",
        ref: baseArr,
        scale: 8,
      }),
    },
  };
}

/** Deterministic integer-lattice value noise, smoothstep-interpolated. */
function _vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const hsh = (a: number, b: number): number => {
    const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hsh(xi, yi);
  const b = hsh(xi + 1, yi);
  const c = hsh(xi, yi + 1);
  const d = hsh(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** 5-octave fbm in (lon,lat) DEGREES — a CONTINUOUS field, so it is
 *  byte-identical regardless of the equirect sampling resolution. This is
 *  what makes the synthetic oracle a valid apples-to-apples resolution
 *  probe (texel-index noise would differ per W and re-contaminate it). */
function _fbm(lon: number, lat: number): number {
  let amp = 1;
  let freq = 0.06;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < 5; o++) {
    sum += amp * _vnoise(lon * freq + 13.7, lat * freq + 7.3);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm; // ~0..1
}

/** JS port of `earth_dem_like_draft` (bake_equirect.rs): 6 cosine-dome
 *  continents over continuous negative bathymetry, evaluated directly per
 *  equirect texel so the oracle is resolution-flexible and fixture-free.
 *  Land carries continuous fbm micro-relief (drainage seeds) so erosion
 *  actually engages — the bare analytic dome is too smooth to erode and
 *  is useless as an erosion oracle. Lets dendritic structure + the true
 *  resolution behaviour be judged at production resolution headlessly. */
function _demLikeField(
  w: number,
  h: number,
): { base: Float32Array; precip: Float32Array } {
  const cont: Array<[number, number, number, number, number]> = [
    [40, 45, 70, 32, 0.92],
    [-55, 5, 38, 45, 0.7],
    [135, -28, 30, 20, 0.55],
    [-110, 42, 32, 26, 0.85],
    [95, -68, 26, 14, 0.97],
    [160, 18, 12, 9, 0.3],
  ];
  const base = new Float32Array(w * h);
  const precip = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const lat = 90 - ((y + 0.5) / h) * 180;
    const cl = Math.cos((lat * Math.PI) / 180);
    for (let x = 0; x < w; x++) {
      const lon = ((x + 0.5) / w) * 360 - 180;
      let best = 0;
      let minND = Infinity;
      for (const [clon, clat, rlon, rlat, peak] of cont) {
        let dlon = lon - clon;
        while (dlon > 180) dlon -= 360;
        while (dlon < -180) dlon += 360;
        const dlat = lat - clat;
        const d = Math.sqrt((dlon / rlon) ** 2 + (dlat / rlat) ** 2);
        if (d < minND) minND = d;
        if (d < 1) {
          const dome = peak * (0.5 + 0.5 * Math.cos(d * Math.PI));
          const rip = 0.05 * Math.sin(lon * 0.13) * Math.cos(lat * 0.17);
          const e = Math.min(1, Math.max(0.06, dome + rip));
          if (e > best) best = e;
        }
      }
      let elev: number;
      if (best > 0) {
        // Continuous multi-scale micro-relief (drainage seeds). Amplitude
        // scales with elevation so peaks/flanks roughen but the macro dome
        // silhouette and the 0.06 coastal floor are preserved.
        const micro =
          0.16 * (_fbm(lon, lat) - 0.5) +
          0.06 * (_vnoise(lon * 0.55 + 5.0, lat * 0.55 + 9.0) - 0.5);
        elev = Math.max(0.06, Math.min(1, best + micro * (0.35 + 0.65 * best)));
      } else {
        const dt = Math.min(1, Math.max(0, (minND - 1) * 0.6));
        elev = Math.max(-1, Math.min(1, -(0.02 + 0.98 * dt)));
      }
      const i = y * w + x;
      base[i] = elev;
      precip[i] = 0.35 + 0.65 * cl * cl;
    }
  }
  return { base, precip };
}

/** Real-GPU bake on the self-contained DEM-like field at arbitrary
 *  resolution (default 1024×512 — production scale, where dendritic
 *  drainage can actually resolve). The honest CP0 dendritic-quality gate. */
export async function runSyntheticDemRelief(
  res?: { w: number; h: number },
  overrideCfg?: Record<string, number>,
  injectedRenderer?: THREE.WebGLRenderer,
): Promise<ErosionReliefResult> {
  const consoleErrs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => {
    consoleErrs.push("ERR " + a.map(String).join(" "));
    origErr.apply(console, a as []);
  };
  try {
    const hyd = await import("./hydraulic");
    const eq = await import("./equirectInput");
    const gp = await import("./glPass");
    const w = res?.w ?? 1024;
    const h = res?.h ?? 512;
    const { base, precip } = _demLikeField(w, h);
    const r = await _bakeAndRenderRelief(
      hyd,
      eq,
      gp,
      base,
      precip,
      w,
      h,
      overrideCfg,
      injectedRenderer,
    );
    console.error = origErr;
    r.consoleErrs = consoleErrs;
    return r;
  } catch (e) {
    console.error = origErr;
    return { ran: false, error: String(e), consoleErrs };
  }
}
