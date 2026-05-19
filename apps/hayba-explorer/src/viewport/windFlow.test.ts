import { describe, it, expect } from "vitest";
import {
  INIT_FRAG,
  ADVECT_FRAG,
  FADE_FRAG,
  SPLAT_VERT,
  SPLAT_FRAG,
} from "./windFlow.glsl";
import {
  windFlowSize,
  __clampStepDt,
  PARTICLE_DIM,
  PARTICLE_COUNT,
} from "./windFlow";

describe("NX-3-v2c INIT_FRAG", () => {
  it("seeds the particle state texture with hashed pos + age + seed", () => {
    expect(typeof INIT_FRAG).toBe("string");
    expect(INIT_FRAG).toMatch(/uniform vec2 uGrid;/);
    expect(INIT_FRAG).toMatch(/hash\(/);
    expect(INIT_FRAG).toMatch(/fragColor = vec4\(/);
    expect(INIT_FRAG).not.toMatch(/`/);
    expect(
      INIT_FRAG.split("\n").filter(
        (l) => /^\s*uniform /.test(l) && l.includes("//"),
      ).length,
    ).toBe(0);
  });
});

describe("NX-3-v2c ADVECT_FRAG", () => {
  it("advects particle state along normalised wind dir + age + respawn", () => {
    expect(typeof ADVECT_FRAG).toBe("string");
    expect(ADVECT_FRAG).toMatch(/uniform sampler2D uPrev;/);
    expect(ADVECT_FRAG).toMatch(/uniform sampler2D uWind;/);
    expect(ADVECT_FRAG).toMatch(/uniform vec2 uGrid;/);
    expect(ADVECT_FRAG).toMatch(/uniform float uDt;/);
    expect(ADVECT_FRAG).toMatch(/uniform float uTime;/);
    expect(ADVECT_FRAG).toMatch(/texelFetch\(uPrev/);
    expect(ADVECT_FRAG).toMatch(/v \/ vlen/);
    expect(ADVECT_FRAG).toMatch(/fract\(pos\.x\)/);
    expect(ADVECT_FRAG).toMatch(/clamp\(pos\.y, 0\.0, 1\.0\)/);
    expect(ADVECT_FRAG).toMatch(/age > LIFE/);
    expect(ADVECT_FRAG).toMatch(/fragColor = vec4\(pos/);
    expect(ADVECT_FRAG).not.toMatch(/`/);
  });
});

describe("NX-3-v2c FADE_FRAG", () => {
  it("samples the trail and writes prev * 0.9", () => {
    expect(typeof FADE_FRAG).toBe("string");
    expect(FADE_FRAG).toMatch(/uniform sampler2D uPrevTrail;/);
    expect(FADE_FRAG).toMatch(/uniform vec2 uGrid;/);
    expect(FADE_FRAG).toMatch(/\* 0\.9/);
    expect(FADE_FRAG).toMatch(/fragColor = vec4\(/);
    expect(FADE_FRAG).not.toMatch(/`/);
  });
});

describe("NX-3-v2c SPLAT_VERT", () => {
  it("positions points by gl_VertexID into a particle texture", () => {
    expect(typeof SPLAT_VERT).toBe("string");
    expect(SPLAT_VERT).toMatch(/uniform sampler2D uPart;/);
    expect(SPLAT_VERT).toMatch(/uniform vec2 uPartDim;/);
    expect(SPLAT_VERT).toMatch(/uniform sampler2D uWind;/);
    expect(SPLAT_VERT).toMatch(/out float v_intensity;/);
    expect(SPLAT_VERT).toMatch(/gl_VertexID/);
    expect(SPLAT_VERT).toMatch(/texelFetch\(uPart/);
    expect(SPLAT_VERT).toMatch(/gl_Position = vec4\(/);
    expect(SPLAT_VERT).toMatch(/gl_PointSize/);
    expect(SPLAT_VERT).toMatch(/smoothstep\(0\.0, SPD_REF/);
    expect(SPLAT_VERT).not.toMatch(/`/);
  });
});

describe("NX-3-v2c SPLAT_FRAG", () => {
  it("renders point with v_intensity + radial falloff", () => {
    expect(typeof SPLAT_FRAG).toBe("string");
    expect(SPLAT_FRAG).toMatch(/in float v_intensity;/);
    expect(SPLAT_FRAG).toMatch(/gl_PointCoord/);
    expect(SPLAT_FRAG).toMatch(/fragColor = vec4\(vec3\(/);
    expect(SPLAT_FRAG).not.toMatch(/`/);
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
