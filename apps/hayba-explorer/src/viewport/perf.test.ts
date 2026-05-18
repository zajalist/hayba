import { describe, it, expect } from "vitest";
import {
  createFrameMeter,
  adaptiveScale,
  createRenderGate,
} from "./perf";
import { DEFAULT_BAKE_RES, BAKE_RES_TIERS } from "./bake/bakeResolution";

describe("createFrameMeter (NX-1)", () => {
  it("reports fps/ms and an EMA that converges toward steady input", () => {
    const m = createFrameMeter(0.5);
    let r = m.push(20); // 50 fps
    expect(Math.round(r.fps)).toBe(50);
    expect(r.ms).toBe(20);
    for (let i = 0; i < 30; i++) r = m.push(10); // settle to 100 fps
    expect(r.emaMs).toBeGreaterThan(9.9);
    expect(r.emaMs).toBeLessThan(10.1);
    expect(Math.round(r.fps)).toBe(100);
  });
  it("guards a zero/negative dt (no Infinity fps)", () => {
    const r = createFrameMeter().push(0);
    expect(Number.isFinite(r.fps)).toBe(true);
  });
});

describe("adaptiveScale (NX-1 hysteresis)", () => {
  const O = {
    budgetMs: 22,
    floor: 0.5,
    ceil: 1,
    downStep: 0.85,
    upStep: 1.05,
    upHoldFrames: 3,
  };
  it("drops scale immediately when over budget, resets hold", () => {
    const r = adaptiveScale(40, 1, 2, O);
    expect(r.scale).toBeCloseTo(0.85, 5);
    expect(r.hold).toBe(0);
  });
  it("clamps down to the floor", () => {
    let s = 1;
    for (let i = 0; i < 20; i++) s = adaptiveScale(99, s, 0, O).scale;
    expect(s).toBe(0.5);
  });
  it("only scales up after upHoldFrames comfortable frames, then clamps to ceil", () => {
    let s = 0.6,
      h = 0;
    let r = adaptiveScale(10, s, h, O);
    expect(r.scale).toBe(0.6);
    expect(r.hold).toBe(1);
    r = adaptiveScale(10, r.scale, r.hold, O);
    r = adaptiveScale(10, r.scale, r.hold, O);
    expect(r.scale).toBeCloseTo(0.63, 5);
    expect(r.hold).toBe(0);
    let s2 = 0.99,
      h2 = 0;
    for (let i = 0; i < 50; i++) {
      const x = adaptiveScale(10, s2, h2, O);
      s2 = x.scale;
      h2 = x.hold;
    }
    expect(s2).toBe(1);
  });
  it("does not oscillate on a noisy near-budget trace", () => {
    let s = 1,
      h = 0;
    const seen: number[] = [];
    for (let i = 0; i < 200; i++) {
      const ema = 21 + (i % 2 === 0 ? -1 : 1);
      const x = adaptiveScale(ema, s, h, O);
      s = x.scale;
      h = x.hold;
      seen.push(s);
    }
    expect(Math.max(...seen)).toBe(1);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0.5);
    const tail = seen.slice(-50);
    expect(new Set(tail).size).toBeLessThanOrEqual(2);
  });
});

describe("createRenderGate (NX-1 on-demand)", () => {
  it("renders when dirty, clears the flag, idles after the settle window", () => {
    const g = createRenderGate(250);
    expect(g.tick(1000)).toBe(false);
    g.markDirty(1000);
    expect(g.tick(1000)).toBe(true);
    g.clear();
    expect(g.tick(1100)).toBe(true);
    expect(g.tick(1300)).toBe(false);
  });
  it("re-arms on markDirty after idling", () => {
    const g = createRenderGate(250);
    g.markDirty(0);
    g.clear();
    expect(g.tick(1000)).toBe(false);
    g.markDirty(1000);
    expect(g.tick(1000)).toBe(true);
  });
});

describe("default bake tier (NX-1)", () => {
  it("DEFAULT_BAKE_RES is tier 0 = 1024x512", () => {
    expect(DEFAULT_BAKE_RES).toBe(BAKE_RES_TIERS[0]);
    expect(DEFAULT_BAKE_RES).toEqual({ w: 1024, h: 512 });
  });
});
