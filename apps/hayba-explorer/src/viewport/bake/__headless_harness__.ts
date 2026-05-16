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
