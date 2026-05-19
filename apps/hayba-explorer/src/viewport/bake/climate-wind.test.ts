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
    expect(CLIMATE_FRAG).toContain(
      "float P = clamp(0.85*itcz - 0.6*subtrop + 0.55*midlat - 0.4*polar + 0.35, 0.0, 1.0);",
    );
    expect(CLIMATE_FRAG).toContain(
      "float glac = 1.0 - smoothstep(uGlacFullC, uGlacOnsetC, T);",
    );
    expect(CLIMATE_FRAG).toContain(
      "fragColor = vec4(fin(T), fin(P), fin(windAz), clamp(fin(glac), 0.0, 1.0));",
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
