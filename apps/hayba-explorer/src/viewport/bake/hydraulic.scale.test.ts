import { describe, it, expect } from "vitest";
import { DEFAULT_HYDRAULIC } from "./hydraulic";

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
});
