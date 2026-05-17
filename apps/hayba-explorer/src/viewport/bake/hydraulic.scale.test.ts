import { describe, it, expect } from "vitest";
import { DEFAULT_HYDRAULIC } from "./hydraulic";
import {
  ERODE_FRAG,
  THERMAL_FRAG,
  DETAIL_MASK_FRAG,
  CARVE_RIVERS_FRAG,
  INIT_ACC_FRAG,
  ACCUM_FRAG,
} from "./hydraulic.glsl";

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

  it("flux-derived terms are resolution-invariant via uResScale (#217)", () => {
    // ERODE keeps uResScale (#217); CARVE moved to accumulation/stream-power (#218).
    expect(ERODE_FRAG).toMatch(/uniform float uResScale;/);
    // ERODE capacity uses the rescaled velocity, not raw vmag.
    expect(ERODE_FRAG).toMatch(/vmag \* uResScale/);
  });

  it("ERODE_FRAG base-level clamp keeps incision stable under uResScale (#217)", () => {
    // Unbounded ERODE capacity + a large uResScale boost (high W) could
    // over-incise an isolated high-flux cell far below base level
    // (minB ≪ -1). A base-level clamp vs the lowest land neighbour (as in
    // CARVE_RIVERS) bounds it without flattening dendritic valleys.
    expect(ERODE_FRAG).toMatch(/max\(b, minNb - 1\.0e-3\)/);
    expect(ERODE_FRAG).toMatch(/if \(!\(aL\.a > 0\.5\)\) minNb = min/);
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

describe("S2.4 elevation/slope detailMask (gate relief to mountains)", () => {
  it("DETAIL_MASK_FRAG has an elevation gate AND a slope gate, ocean→0, 1-channel", () => {
    expect(typeof DETAIL_MASK_FRAG).toBe("string");
    // Two smoothstep gates: elevation (vs verticality) and slope.
    const gates = DETAIL_MASK_FRAG.match(/smoothstep\(/g) ?? [];
    expect(gates.length).toBeGreaterThanOrEqual(2);
    expect(DETAIL_MASK_FRAG).toMatch(/uniform float uElevFloor;/);
    expect(DETAIL_MASK_FRAG).toMatch(/uniform float uElevMid;/);
    expect(DETAIL_MASK_FRAG).toMatch(/uniform float uSlopeFloor;/);
    expect(DETAIL_MASK_FRAG).toMatch(/uniform float uSlopeMid;/);
    expect(DETAIL_MASK_FRAG).toMatch(/uniform float uVerticality;/);
    expect(DETAIL_MASK_FRAG).toMatch(/uniform float uTerrainScale;/);
    // ocean writes 0 mask; output packs the mask in .r.
    expect(DETAIL_MASK_FRAG).toMatch(/a\.a > 0\.5/);
    expect(DETAIL_MASK_FRAG).toMatch(/fragColor = vec4\(/);
  });
  it("ERODE_FRAG and THERMAL_FRAG sample uDetailMask", () => {
    expect(ERODE_FRAG).toMatch(/uniform sampler2D uDetailMask;/);
    expect(THERMAL_FRAG).toMatch(/uniform sampler2D uDetailMask;/);
  });
  it("DEFAULT_HYDRAULIC carries the S2.4 gate knobs", () => {
    expect(typeof DEFAULT_HYDRAULIC.elevFloor).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.elevMid).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.slopeFloor).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.slopeMid).toBe("number");
    expect(DEFAULT_HYDRAULIC.elevFloor).toBeLessThan(DEFAULT_HYDRAULIC.elevMid);
    expect(DEFAULT_HYDRAULIC.slopeFloor).toBeLessThan(DEFAULT_HYDRAULIC.slopeMid);
  });
});

describe("S2.3→ flow-accumulation drainage + stream-power (#218)", () => {
  it("DEFAULT_HYDRAULIC carries the accumulation/stream-power knobs", () => {
    expect(typeof DEFAULT_HYDRAULIC.accumIters).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.accumEveryN).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.mfdExponent).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.streamK).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.spM).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.spN).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.accMin).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.accResScale).toBe("number");
    expect(DEFAULT_HYDRAULIC.accumIters).toBeGreaterThan(0);
    expect(DEFAULT_HYDRAULIC.accumEveryN).toBeGreaterThan(0);
    expect(DEFAULT_HYDRAULIC.mfdExponent).toBeGreaterThan(0);
    expect(DEFAULT_HYDRAULIC.spM).toBeGreaterThan(0);
    expect(DEFAULT_HYDRAULIC.spN).toBeGreaterThan(0);
    expect("riverThreshold0" in DEFAULT_HYDRAULIC).toBe(false);
    expect("riverThreshold1" in DEFAULT_HYDRAULIC).toBe(false);
  });
});

describe("#218 accumulation passes", () => {
  it("INIT_ACC_FRAG seeds precip runoff, ocean->0", () => {
    expect(typeof INIT_ACC_FRAG).toBe("string");
    expect(INIT_ACC_FRAG).toMatch(/uniform sampler2D uA;/);
    expect(INIT_ACC_FRAG).toMatch(/uniform sampler2D uPrecip;/);
    expect(INIT_ACC_FRAG).toMatch(/uniform float uAccMin;/);
    expect(INIT_ACC_FRAG).toMatch(/a\.a > 0\.5/);
  });
  it("ACCUM_FRAG is an 8-neighbour single-flow (D8) gather with jitter (R1b)", () => {
    expect(typeof ACCUM_FRAG).toBe("string");
    expect(ACCUM_FRAG).toMatch(/uniform sampler2D uA;/);
    expect(ACCUM_FRAG).toMatch(/uniform sampler2D uAcc;/);
    expect(ACCUM_FRAG).toMatch(/uniform sampler2D uPrecip;/);
    expect(ACCUM_FRAG).toMatch(/uniform float uSfdJitter;/);
    expect(ACCUM_FRAG).not.toMatch(/uMfdExponent/);
    expect(ACCUM_FRAG).toMatch(/uniform float uPoleBand;/);
    expect(ACCUM_FRAG).toMatch(/uniform float uAccMin;/);
    expect(ACCUM_FRAG).toMatch(/a\.a > 0\.5/);
    // single steepest-descent direction selector + jitter
    expect(ACCUM_FRAG).toMatch(/int sdir\(/);
    expect(ACCUM_FRAG).toMatch(/uSfdJitter \* \(jit\(/);
    expect(ACCUM_FRAG).toMatch(/ivec2\[8\]/);
    expect((ACCUM_FRAG.match(/ivec2\(/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });
});

describe("#218 R2 ERODE discharge-weighted capacity", () => {
  it("ERODE capacity is multiplied by Q^uSpM from the SFD ACC field", () => {
    expect(ERODE_FRAG).toMatch(/uniform sampler2D uAcc;/);
    expect(ERODE_FRAG).toMatch(/uniform float uAccResScale;/);
    expect(ERODE_FRAG).toMatch(/uniform float uSpM;/);
    expect(ERODE_FRAG).toMatch(
      /float C = uStrength \* \(vmag \* uResScale\) \* slope \* pow\(max\(Q, 0\.0\), uSpM\)/,
    );
    // ERODE keeps its #217 resolution + base-level-clamp machinery.
    expect(ERODE_FRAG).toMatch(/vmag \* uResScale/);
    expect(ERODE_FRAG).toMatch(/max\(b, minNb - 1\.0e-3\)/);
  });
});

describe("#218 CARVE_RIVERS stream-power on accumulation", () => {
  it("drives off uAcc with Q^spM*S^spN, keeps anti-moat + base clamp", () => {
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform sampler2D uAcc;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uStreamK;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uSpM;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uSpN;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uAccResScale;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/pow\(.*uSpM\)/);
    expect(CARVE_RIVERS_FRAG).toMatch(/pow\(.*uSpN\)/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uVerticality;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uTerrainScale;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uSinMin;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/smoothstep\(0\.0, uConcaveScale, lap\)/);
    // R1a: Q-proportional incision budget (1e-3 floor + channelDepth term)
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uChannelDepth;/);
    expect(CARVE_RIVERS_FRAG).toMatch(
      /float budget = 1\.0e-3 \+ uChannelDepth \* concave \* pow\(max\(Q, 0\.0\), uSpM\)/,
    );
    expect(CARVE_RIVERS_FRAG).toMatch(/max\(nb, minNb - budget\)/);
    expect(CARVE_RIVERS_FRAG).toMatch(/a\.a > 0\.5/);
    expect(CARVE_RIVERS_FRAG).not.toMatch(/uRiverThreshold0/);
    expect(CARVE_RIVERS_FRAG).not.toMatch(/uRiverThreshold1/);
    expect(CARVE_RIVERS_FRAG).not.toMatch(/uResScale/);
  });
});

describe("#226 multi-pattern drainage config", () => {
  it("DEFAULT_HYDRAULIC carries the Phase-A pattern knobs", () => {
    for (const k of ["radialStrength","parallelStrength","centripetalStrength",
      "uniformityThreshold","curvatureScale","ctrlRadius","endorheicSteps",
      "patternMax"] as const) {
      expect(typeof DEFAULT_HYDRAULIC[k]).toBe("number");
    }
    expect(DEFAULT_HYDRAULIC.patternMax).toBeGreaterThan(0);
    expect(DEFAULT_HYDRAULIC.patternMax).toBeLessThan(1);
    expect(DEFAULT_HYDRAULIC.ctrlRadius).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_HYDRAULIC.uniformityThreshold).toBeGreaterThan(0);
  });
});
