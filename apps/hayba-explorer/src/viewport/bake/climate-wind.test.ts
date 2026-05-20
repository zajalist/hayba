import { describe, it, expect } from "vitest";
import {
  MSLP_FRAG,
  BLUR_H_FRAG,
  BLUR_V_FRAG,
  CLIMATE_FRAG,
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
    // form that composes onshore moisture additively before oro:
    expect(CLIMATE_FRAG).toContain(
      "P = clamp((P + onshoreBonus) * oro, 0.05, 1.0);",
    );
  });
});

describe("CLIM-MONSOON onshore moisture transport", () => {
  it("CLIMATE_FRAG declares uOnshoreGain uniform", () => {
    expect(CLIMATE_FRAG).toContain("uniform float uOnshoreGain;");
  });
  it("CLIMATE_FRAG walks K=4 cells upwind to measure ocean fraction", () => {
    expect(CLIMATE_FRAG).toContain("vec2 wdir = (wmag > 1e-6) ? wvec / wmag : vec2(0.0);");
    expect(CLIMATE_FRAG).toContain("float oceanFrac = 0.0;");
    expect(CLIMATE_FRAG).toContain("for (int k = 1; k <= 4; k++) {");
    expect(CLIMATE_FRAG).toContain("int dx = int(-wdir.x * float(k) * 4.0);");
    expect(CLIMATE_FRAG).toContain("int dy = int(-wdir.y * float(k) * 4.0);");
    expect(CLIMATE_FRAG).toContain("float upH = texelFetch(uA, ivec2(ux, uy), 0).r;");
    expect(CLIMATE_FRAG).toContain("oceanFrac += float(upH < 0.0);");
    expect(CLIMATE_FRAG).toContain("oceanFrac *= 0.25;");
  });
  it("CLIMATE_FRAG adds onshore moisture additively then applies orographic", () => {
    // Additive bonus (lifts dry zonal areas) only above 50% ocean upwind.
    // Combined with the orographic multiplier so wet wind + windward
    // slope = monsoon-intense rain.
    expect(CLIMATE_FRAG).toContain(
      "float onshoreBonus = uOnshoreGain * max(oceanFrac - 0.5, 0.0);",
    );
    expect(CLIMATE_FRAG).toContain(
      "P = clamp((P + onshoreBonus) * oro, 0.05, 1.0);",
    );
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
