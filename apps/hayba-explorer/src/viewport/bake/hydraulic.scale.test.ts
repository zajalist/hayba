import { describe, it, expect } from "vitest";
import { DEFAULT_HYDRAULIC } from "./hydraulic";
import { ERODE_FRAG, THERMAL_FRAG } from "./hydraulic.glsl";

describe("S1 scale config", () => {
  it("DEFAULT_HYDRAULIC drops the ad-hoc clamp/uplift and adds scale knobs", () => {
    // The metre-denominated model replaces the maxDeltaB clamp + uplift.
    expect("maxDeltaB" in DEFAULT_HYDRAULIC).toBe(false);
    expect("uplift" in DEFAULT_HYDRAULIC).toBe(false);
    // New physical strength knobs (dimensionless, integrated over duration).
    expect(typeof DEFAULT_HYDRAULIC.strength).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.downcutting).toBe("number");
    expect(DEFAULT_HYDRAULIC.strength).toBeGreaterThan(0);
    expect(DEFAULT_HYDRAULIC.strength).toBeLessThan(0.2); // "not way too strong"
  });

  it("ERODE_FRAG is metre-denominated, no clamp/uplift uniforms", () => {
    expect(ERODE_FRAG).not.toMatch(/uMaxDeltaB/);
    expect(ERODE_FRAG).not.toMatch(/uUplift/);
    expect(ERODE_FRAG).toMatch(/uniform float uStrength;/);
    expect(ERODE_FRAG).toMatch(/uniform float uDowncutting;/);
    expect(ERODE_FRAG).toMatch(/uniform float uVerticality;/);
    expect(ERODE_FRAG).toMatch(/uniform float uTerrainScale;/);
  });
});

describe("S2.2 anisotropic thermal/talus (ridgeline pass)", () => {
  it("THERMAL_FRAG declares the anisotropic metre-scale talus uniforms", () => {
    expect(THERMAL_FRAG).toMatch(/uniform float uTanTalus;/);
    expect(THERMAL_FRAG).toMatch(/uniform float uStrengthThermal;/);
    expect(THERMAL_FRAG).toMatch(/uniform float uAnisotropy;/);
    expect(THERMAL_FRAG).toMatch(/uniform float uSedimentRemoval;/);
    expect(THERMAL_FRAG).toMatch(/uniform float uVerticality;/);
    expect(THERMAL_FRAG).toMatch(/uniform float uTerrainScale;/);
    expect(THERMAL_FRAG).toMatch(/uniform float uPoleBand;/);
  });
  it("THERMAL_FRAG has the anisotropy direction-bias term and drops the old uKt/uCellL form", () => {
    // Direction-dependent talus: effStrength scaled by (1 + uAnisotropy*dirBias).
    expect(THERMAL_FRAG).toMatch(/1\.0 \+ uAnisotropy \*/);
    // Legacy isotropic uKt / uCellL-denominated thermal is gone.
    expect(THERMAL_FRAG).not.toMatch(/uniform float uKt;/);
    expect(THERMAL_FRAG).not.toMatch(/uniform float uCellL;/);
  });
  it("DEFAULT_HYDRAULIC carries the S2.2 talus knobs (and drops old kt/tanTalus)", () => {
    expect(typeof DEFAULT_HYDRAULIC.talusAngle).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.anisotropy).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.sedimentRemoval).toBe("number");
    expect(DEFAULT_HYDRAULIC.anisotropy).toBeGreaterThanOrEqual(0);
    expect(DEFAULT_HYDRAULIC.anisotropy).toBeLessThanOrEqual(1);
    expect("kt" in DEFAULT_HYDRAULIC).toBe(false);
    expect("tanTalus" in DEFAULT_HYDRAULIC).toBe(false);
  });
});
