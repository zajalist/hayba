import { describe, it, expect } from "vitest";
import { DEFAULT_HYDRAULIC } from "./hydraulic";
import {
  ERODE_FRAG,
  THERMAL_FRAG,
  DETAIL_MASK_FRAG,
  CARVE_RIVERS_FRAG,
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
    // Measured (same-input oracle, 256/512/1024): erosion ∝ W^-0.89
    // because virtual-pipe flux ∝ ~1/W. Both flux-derived drivers must be
    // normalised by uResScale = (W/REF)^0.89 so erosion is W-invariant.
    expect(ERODE_FRAG).toMatch(/uniform float uResScale;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uResScale;/);
    // ERODE capacity uses the rescaled velocity, not raw vmag.
    expect(ERODE_FRAG).toMatch(/vmag \* uResScale/);
    // CARVE_RIVERS rescales flux BEFORE the river smoothstep.
    expect(CARVE_RIVERS_FRAG).toMatch(/length\(f\) \* uResScale/);
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

describe("S2.3 flow-mask river incision (the valley/ridge maker)", () => {
  it("CARVE_RIVERS_FRAG thresholds flux into a river mask and only lowers b", () => {
    expect(typeof CARVE_RIVERS_FRAG).toBe("string");
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform sampler2D uF;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform sampler2D uDetailMask;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uRiverThreshold0;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uRiverThreshold1;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uRiverDepth;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uDowncutting;/);
    expect(CARVE_RIVERS_FRAG).toMatch(/smoothstep\(/);
    // ocean early-return byte-identical (load-bearing invariant)
    expect(CARVE_RIVERS_FRAG).toMatch(/a\.a > 0\.5/);
    expect(CARVE_RIVERS_FRAG).toMatch(/fragColor = a; return;/);
    // carve only ever subtracts (never raises b)
    expect(CARVE_RIVERS_FRAG).toMatch(/a\.r - /);
  });
  it("CARVE_RIVERS_FRAG has the concavity gate + base-level clamp (anti-moat)", () => {
    expect(CARVE_RIVERS_FRAG).toMatch(/uniform float uConcaveScale;/);
    // discrete Laplacian (mean of 4 nbrs - self) → concave factor
    expect(CARVE_RIVERS_FRAG).toMatch(/\* 0\.25 - a\.r/);
    expect(CARVE_RIVERS_FRAG).toMatch(
      /smoothstep\(0\.0, uConcaveScale, lap\)/,
    );
    expect(CARVE_RIVERS_FRAG).toMatch(/river \* concave/);
    // base-level clamp: don't incise below the lowest land neighbour
    expect(CARVE_RIVERS_FRAG).toMatch(/max\(nb, minNb/);
  });
  it("DEFAULT_HYDRAULIC carries the S2.3 river + concavity knobs", () => {
    expect(typeof DEFAULT_HYDRAULIC.riverThreshold0).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.riverThreshold1).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.riverDepth).toBe("number");
    expect(typeof DEFAULT_HYDRAULIC.concaveScale).toBe("number");
    expect(DEFAULT_HYDRAULIC.riverThreshold0).toBeLessThan(
      DEFAULT_HYDRAULIC.riverThreshold1,
    );
    expect(DEFAULT_HYDRAULIC.riverDepth).toBeGreaterThan(0);
    expect(DEFAULT_HYDRAULIC.concaveScale).toBeGreaterThan(0);
  });
});
