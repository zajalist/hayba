import { describe, it, expect } from "vitest";
import {
  MSLP_FRAG,
  BLUR_H_FRAG,
  BLUR_V_FRAG,
  CLIMATE_FRAG,
  DIST_INIT_FRAG,
  DIST_JFA_FRAG,
  DIST_FINAL_FRAG,
} from "./hydraulic.glsl";

describe("NX-2a geostrophic wind GLSL", () => {
  it("MSLP_FRAG computes MdGBWG land/ocean pressure", () => {
    expect(typeof MSLP_FRAG).toBe("string");
    expect(MSLP_FRAG).toContain("uMslpLandBase");
    expect(MSLP_FRAG).toContain("uMslpOceanBase");
    expect(MSLP_FRAG).toContain("a.r < 0.0");
    expect(MSLP_FRAG).toContain("cos(lat * 4.0)");
    expect(MSLP_FRAG).toContain("cos(lat * 6.0)");
  });
  it("separable blur: H wraps longitude, V clamps latitude", () => {
    expect(BLUR_H_FRAG).toContain("uBlurSigma");
    expect(BLUR_H_FRAG).toContain("xw(rc.x + i, wh.x)");
    expect(BLUR_V_FRAG).toContain("uBlurSigma");
    expect(BLUR_V_FRAG).toContain("yc(rc.y + i, wh.y)");
    expect(BLUR_H_FRAG).toContain("const int R =");
    expect(BLUR_V_FRAG).toContain("const int R =");
  });
  it("CLIMATE_FRAG wind block is geostrophic (old 3-band azimuth gone)", () => {
    expect(CLIMATE_FRAG).toContain("uniform sampler2D uMSLP;");
    expect(CLIMATE_FRAG).toContain("uniform float uCoriolisGain;");
    expect(CLIMATE_FRAG).toContain("uCoriolisGain * s * vec2(-gp.y, gp.x) - gp");
    expect(CLIMATE_FRAG).toContain("float coslat = max(cos(lat), 1e-3);");
    expect(CLIMATE_FRAG).not.toContain(
      'float zsign = (dDeg < 30.0) ? -1.0 : ((dDeg < 60.0) ? 1.0 : -1.0);',
    );
    expect(CLIMATE_FRAG).not.toContain("vec2 wv = normalize(vec2(zsign");
  });
  it("CLIMATE_FRAG temp/precip/glaciation byte-unchanged (regression pin)", () => {
    expect(CLIMATE_FRAG).toContain(
      "float T = uTEquatorC - uTLatDropC * (s * s) - uLapseCPerKm * elevKm;",
    );
    // NX-2b2: precip curve intentionally re-tuned (real 0.55 moisture
    // baseline; subtropics/poles are dry DIPS not white) — the NX-2b
    // curve over-dried the planet. This pin guards the NEW curve.
    expect(CLIMATE_FRAG).toContain(
      "float P = clamp(0.55 + 0.45*itcz + 0.30*midlat - 0.35*subtrop - 0.22*polar, 0.05, 1.0);",
    );
    // CLIM-ITCZ-MIGRATION: bands still measured via `abs(dDeg - X)` but
    // dDeg is now derived from the seasonally-migrating solar latitude
    // (see the migration test below); the band offsets (25/50/66/88)
    // are unchanged.
    expect(CLIMATE_FRAG).toContain(
      "1.0 - smoothstep(0.0, 14.0, abs(dDeg - 25.0))",
    );
    expect(CLIMATE_FRAG).toContain(
      "float glac = 1.0 - smoothstep(uGlacFullC, uGlacOnsetC, T);",
    );
    expect(CLIMATE_FRAG).toContain(
      "fragColor = vec4(fin(T), fin(P), fin(windAz), clamp(fin(glac), 0.0, 1.0));",
    );
  });
});

describe("P2.2-oro orographic precipitation", () => {
  it("CLIMATE_FRAG declares uOrographicGain + uRainShadow uniforms", () => {
    expect(CLIMATE_FRAG).toContain("uniform float uOrographicGain;");
    expect(CLIMATE_FRAG).toContain("uniform float uRainShadow;");
  });
  it("CLIMATE_FRAG samples 4-neighbour terrain to build a gradient", () => {
    expect(CLIMATE_FRAG).toContain("vec4 aLh = loadA(uA, uGrid, rc.x - 1, rc.y);");
    expect(CLIMATE_FRAG).toContain("vec4 aRh = loadA(uA, uGrid, rc.x + 1, rc.y);");
    expect(CLIMATE_FRAG).toContain("vec4 aNh = loadA(uA, uGrid, rc.x, rc.y - 1);");
    expect(CLIMATE_FRAG).toContain("vec4 aSh = loadA(uA, uGrid, rc.x, rc.y + 1);");
    expect(CLIMATE_FRAG).toContain(
      "vec2 gradH = vec2(aRh.r - aLh.r, aNh.r - aSh.r) * 0.5;",
    );
  });
  it("CLIMATE_FRAG modulates P by wind · grad(h) with shadow split", () => {
    // Upslope = cos angle between wind dir and gradient dir, guarded
    // against zero magnitudes so flats / ocean produce oro=1.0 (no-op).
    expect(CLIMATE_FRAG).toContain(
      "float upslope = (ghlen > 1e-6 && wmag > 1e-6) ? dot(wvec / wmag, gradH / ghlen) : 0.0;",
    );
    expect(CLIMATE_FRAG).toContain(
      "float oro = 1.0 + uOrographicGain * max(upslope, 0.0) - uRainShadow * max(-upslope, 0.0);",
    );
    // CLIM-MONSOON replaced the original `P = clamp(P * oro, …)` with a
    // form that composes onshore moisture and continentality additively
    // before oro:
    expect(CLIMATE_FRAG).toContain(
      "P = clamp((P + onshoreBonus - interiorDry) * oro, 0.05, 1.0);",
    );
  });
});

describe("CLIM-MONSOON onshore moisture transport", () => {
  it("CLIMATE_FRAG declares uOnshoreGain uniform", () => {
    expect(CLIMATE_FRAG).toContain("uniform float uOnshoreGain;");
  });
  it("CLIMATE_FRAG walks K=8 cells upwind to measure ocean fraction", () => {
    // CLIM-MONSOON-TUNE widened the scan from K=4 (≈5°) to K=8 (≈11°)
    // so interior cells can reach distant coasts (Europe→Atlantic,
    // N India→Arabian Sea).
    expect(CLIMATE_FRAG).toContain("vec2 wdir = (wmag > 1e-6) ? wvec / wmag : vec2(0.0);");
    expect(CLIMATE_FRAG).toContain("float oceanFrac = 0.0;");
    expect(CLIMATE_FRAG).toContain("for (int k = 1; k <= 8; k++) {");
    expect(CLIMATE_FRAG).toContain("int dx = int(-wdir.x * float(k) * 4.0);");
    expect(CLIMATE_FRAG).toContain("int dy = int(-wdir.y * float(k) * 4.0);");
    expect(CLIMATE_FRAG).toContain("float upH = texelFetch(uA, ivec2(ux, uy), 0).r;");
    expect(CLIMATE_FRAG).toContain("oceanFrac += float(upH < 0.0);");
    expect(CLIMATE_FRAG).toContain("oceanFrac *= 0.125;");
  });
  it("CLIMATE_FRAG adds onshore moisture additively then applies orographic", () => {
    // Additive bonus (lifts dry zonal areas) only above 50% ocean upwind.
    // Combined with the orographic multiplier so wet wind + windward
    // slope = monsoon-intense rain.
    expect(CLIMATE_FRAG).toContain(
      "float onshoreBonus = uOnshoreGain * max(oceanFrac - 0.5, 0.0);",
    );
    // CLIM-CONTINENTALITY pair: symmetric suppression below 0.5
    expect(CLIMATE_FRAG).toContain("uniform float uContinentalGain;");
    expect(CLIMATE_FRAG).toContain(
      "float interiorDry = uContinentalGain * max(0.5 - oceanFrac, 0.0);",
    );
    expect(CLIMATE_FRAG).toContain(
      "P = clamp((P + onshoreBonus - interiorDry) * oro, 0.05, 1.0);",
    );
  });
});

describe("CLIM-T-CONTINENTALITY (#193: interiors swing more)", () => {
  it("CLIMATE_FRAG declares uContinentalT + season uniforms", () => {
    expect(CLIMATE_FRAG).toContain("uniform float uContinentalT;");
    expect(CLIMATE_FRAG).toContain("uniform float uSeasonAmp;");
    expect(CLIMATE_FRAG).toContain("uniform float uSeasonPhase;");
  });
  it("CLIMATE_FRAG offsets T by hemisphere × season × continentality", () => {
    // isJulyish / hemSign / landMask hoisted to the CLIM-ITCZ-MIGRATION
    // block (used by both ITCZ shift and T continentality).
    expect(CLIMATE_FRAG).toContain("float isJulyish = cos((uSeasonPhase - 6.0) * 0.52359877);");
    expect(CLIMATE_FRAG).toContain("float hemSign = sign(lat);");
    expect(CLIMATE_FRAG).toContain("float landMask = step(0.0, h);");
    expect(CLIMATE_FRAG).toContain(
      "float continentalT = uContinentalT * uSeasonAmp * isJulyish * hemSign * landMask * (1.0 - oceanFrac);",
    );
    expect(CLIMATE_FRAG).toContain("T += continentalT;");
  });
});

describe("COOKBOOK-CLIMATE T2 — JFA distance-to-ocean", () => {
  it("DIST_INIT_FRAG seeds ocean cells with own (x,y), land with (-1,-1,0)", () => {
    expect(typeof DIST_INIT_FRAG).toBe("string");
    expect(DIST_INIT_FRAG).toContain("uniform sampler2D uA;");
    expect(DIST_INIT_FRAG).toContain("bool isOcean = a.r < 0.0;");
    expect(DIST_INIT_FRAG).toContain(
      "fragColor = vec4(float(rc.x), float(rc.y), 1.0, 0.0);",
    );
    expect(DIST_INIT_FRAG).toContain("fragColor = vec4(-1.0, -1.0, 0.0, 0.0);");
  });
  it("DIST_JFA_FRAG honours longitude wrap in the distance metric", () => {
    expect(DIST_JFA_FRAG).toContain("uniform float uStep;");
    expect(DIST_JFA_FRAG).toContain("float wrapDistJfa(vec2 a, vec2 b, float wx)");
    expect(DIST_JFA_FRAG).toContain("dx = min(dx, wx - dx);");
    expect(DIST_JFA_FRAG).toContain("for (int dy = -1; dy <= 1; dy++) {");
    expect(DIST_JFA_FRAG).toContain("for (int dx = -1; dx <= 1; dx++) {");
    expect(DIST_JFA_FRAG).toContain("if (c.z > 0.5) {");
  });
  it("DIST_FINAL_FRAG converts texel distance to km + continentality", () => {
    expect(DIST_FINAL_FRAG).toContain("uniform float uContScaleKm;");
    expect(DIST_FINAL_FRAG).toContain("uniform float uEarthCircKm;");
    expect(DIST_FINAL_FRAG).toContain("float kmPerTex = uEarthCircKm / uGrid.x;");
    expect(DIST_FINAL_FRAG).toContain("float distKm = texDist * kmPerTex;");
    expect(DIST_FINAL_FRAG).toContain(
      "float cont = isLand ? (1.0 - exp(-distKm / uContScaleKm)) : 0.0;",
    );
    expect(DIST_FINAL_FRAG).toContain(
      "fragColor = vec4(distKm, cont, isLand ? 1.0 : 0.0, 0.0);",
    );
  });
});

describe("CLIM-ITCZ-MIGRATION (5° ocean, ~40° land)", () => {
  it("CLIMATE_FRAG declares uItczShift + uItczLandAmp uniforms", () => {
    expect(CLIMATE_FRAG).toContain("uniform float uItczShift;");
    expect(CLIMATE_FRAG).toContain("uniform float uItczLandAmp;");
  });
  it("CLIMATE_FRAG shifts ALL zonal bands by a land-amplified solar latitude", () => {
    expect(CLIMATE_FRAG).toContain("float latDeg = lat * 57.2957795;");
    expect(CLIMATE_FRAG).toContain(
      "float solarLat = uItczShift * uSeasonAmp * isJulyish * (1.0 + uItczLandAmp * landMask);",
    );
    expect(CLIMATE_FRAG).toContain("float dDeg = abs(latDeg - solarLat);");
  });
});

describe("NX-2c seasonality (MdGBWG Jan/July MSLP delta)", () => {
  it("MSLP_FRAG adds season uniforms + land/ocean delta + dfac blend", () => {
    expect(MSLP_FRAG).toContain("uniform float uSeasonAmp;");
    expect(MSLP_FRAG).toContain("uniform float uSeasonPhase;");
    expect(MSLP_FRAG).toContain("15.0 * sin(lat * 2.0)");
    expect(MSLP_FRAG).toContain("36.0 / 7.0");
    expect(MSLP_FRAG).toContain("smoothstep(1.5, 4.5,");
    expect(MSLP_FRAG).toContain("smoothstep(7.5, 10.5,");
    expect(MSLP_FRAG).toContain("uSeasonAmp * dfac * delta");
  });
  it("MSLP_FRAG annual mean byte-preserved (NX-2a regression pin)", () => {
    expect(MSLP_FRAG).toContain(
      "uMslpOceanBase - uMslpOceanAmp * cos(lat * 6.0)",
    );
    expect(MSLP_FRAG).toContain(
      "uMslpLandBase  - uMslpLandAmp  * cos(lat * 4.0)",
    );
  });
});
