import { describe, it, expect } from "vitest";
import { WINDFLOW_FRAG } from "./windFlow.glsl";
import { windFlowSize, __clampStepDt } from "./windFlow";

describe("NX-3-v2b WINDFLOW_FRAG", () => {
  it("is a semi-Lagrangian advected-dye fragment", () => {
    expect(typeof WINDFLOW_FRAG).toBe("string");
    expect(WINDFLOW_FRAG).toMatch(/uniform sampler2D uPrevTrail;/);
    expect(WINDFLOW_FRAG).toMatch(/uniform sampler2D uWind;/);
    expect(WINDFLOW_FRAG).toMatch(/uniform vec2 uGrid;/);
    expect(WINDFLOW_FRAG).toMatch(/uniform float uDt;/);
    expect(WINDFLOW_FRAG).toMatch(/uniform float uTime;/);
    expect(WINDFLOW_FRAG).toMatch(/uv - v \* uDt \* ADV_K/);
    expect(WINDFLOW_FRAG).toMatch(/fract\(prevUv\.x\)/);
    expect(WINDFLOW_FRAG).toMatch(/clamp\(prevUv\.y, 0\.0, 1\.0\)/);
    expect(WINDFLOW_FRAG).toMatch(/\* 0\.9/);
    expect(WINDFLOW_FRAG).toMatch(/texture\(uWind, uv\)/);
    expect(WINDFLOW_FRAG).toMatch(/smoothstep\(0\.0, SPD_REF/);
    expect(WINDFLOW_FRAG).toMatch(/fragColor = vec4\(vec3\(/);
    expect(WINDFLOW_FRAG).not.toMatch(/`/);
    expect(
      WINDFLOW_FRAG.split("\n").filter(
        (l) => /^\s*uniform /.test(l) && l.includes("//"),
      ).length,
    ).toBe(0);
  });
});

describe("NX-3-v2b windFlowSize", () => {
  it("caps the long side to max and keeps a 2:1 equirect aspect", () => {
    expect(windFlowSize(4096, 2048, 1024)).toEqual({ w: 1024, h: 512 });
    expect(windFlowSize(2048, 1024, 1024)).toEqual({ w: 1024, h: 512 });
    expect(windFlowSize(800, 400, 1024)).toEqual({ w: 800, h: 400 });
    const s = windFlowSize(1, 1, 1024);
    expect(Number.isInteger(s.w)).toBe(true);
    expect(s.w).toBeGreaterThan(0);
    expect(s.h).toBeGreaterThan(0);
  });
});

describe("NX-3-v2b step dt clamp", () => {
  it("clamps the per-step dt to <= 1/15 s and floors at 0", () => {
    expect(__clampStepDt(0.5)).toBeCloseTo(1 / 15, 6);
    expect(__clampStepDt(0.001)).toBeCloseTo(0.001, 6);
    expect(__clampStepDt(-3)).toBe(0);
    expect(__clampStepDt(NaN)).toBe(0);
  });
});
