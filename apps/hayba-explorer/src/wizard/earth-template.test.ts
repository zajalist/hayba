import { describe, it, expect, beforeEach } from "vitest";
import {
  earthElevations,
  __resetEarthCache,
} from "./earth-template";
import {
  earthElevationsFromImage,
  loadEarthLum,
  sampleEarthField,
  type EarthLum,
} from "./earth-template";

function mkPositions(n: number): Float32Array {
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    p[3 * i] = Math.cos(a);
    p[3 * i + 1] = i % 2 === 0 ? 0.3 : -0.3;
    p[3 * i + 2] = Math.sin(a);
  }
  return p;
}

describe("earthElevations memoization (LE T1)", () => {
  beforeEach(() => __resetEarthCache());

  it("returns content-equal data on repeat calls for the same n", () => {
    const p = mkPositions(12);
    const a = earthElevations(p, 12);
    const b = earthElevations(p, 12);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it("returns a DISTINCT instance each call (cache not aliased)", () => {
    const p = mkPositions(12);
    const a = earthElevations(p, 12);
    const b = earthElevations(p, 12);
    expect(b).not.toBe(a);
    a[0] = 12345;
    const c = earthElevations(p, 12);
    expect(c[0]).not.toBe(12345);
    expect(c[0]).toBe(b[0]);
  });

  it("recomputes for a different n", () => {
    const a = earthElevations(mkPositions(12), 12);
    const b = earthElevations(mkPositions(8), 8);
    expect(a.length).toBe(12);
    expect(b.length).toBe(8);
  });

  it("__resetEarthCache clears the memo", () => {
    const p = mkPositions(12);
    const a = earthElevations(p, 12);
    __resetEarthCache();
    const b = earthElevations(p, 12);
    expect(b).not.toBe(a);
    expect(Array.from(b)).toEqual(Array.from(a));
  });
});

function stubLum(): EarthLum {
  return { lum: new Float32Array([0.1, 0.9, 0.4, 0.6]), w: 2, h: 2 };
}

describe("loadEarthLum decode-once + retry (LE T2)", () => {
  beforeEach(() => __resetEarthCache());

  it("invokes the injected loader exactly once across many calls", async () => {
    let calls = 0;
    const load = async (): Promise<EarthLum> => {
      calls++;
      return stubLum();
    };
    await loadEarthLum(load);
    await loadEarthLum(load);
    await loadEarthLum(load);
    expect(calls).toBe(1);
  });

  it("nulls the cached promise on rejection so a later call retries", async () => {
    let calls = 0;
    const load = async (): Promise<EarthLum> => {
      calls++;
      if (calls === 1) throw new Error("decode fail");
      return stubLum();
    };
    await expect(loadEarthLum(load)).rejects.toThrow("decode fail");
    const ok = await loadEarthLum(load);
    expect(calls).toBe(2);
    expect(ok.w).toBe(2);
  });
});

describe("sampleEarthField byte-equivalence (LE T2)", () => {
  it("matches the hand-computed elevation for a known EarthLum", () => {
    const positions = new Float32Array([1, 0, 0]); // lat 0, lon 0
    const out = sampleEarthField(stubLum(), positions, 1);
    const landN = (0.6 - 0.46) / (1 - 0.46);
    const expected = Math.pow(landN, 1.6) * 0.85;
    expect(out.length).toBe(1);
    expect(out[0]).toBeCloseTo(expected, 6);
  });
});

describe("earthElevationsFromImage memoization (LE T2)", () => {
  beforeEach(() => __resetEarthCache());

  it("caches by n, returns distinct copies, samples once", async () => {
    let calls = 0;
    const load = async (): Promise<EarthLum> => {
      calls++;
      return stubLum();
    };
    const p = new Float32Array([1, 0, 0]);
    const a = await earthElevationsFromImage(p, 1, load);
    const b = await earthElevationsFromImage(p, 1, load);
    expect(calls).toBe(1);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(b).not.toBe(a);
    a[0] = 999;
    const c = await earthElevationsFromImage(p, 1, load);
    expect(c[0]).not.toBe(999);
  });
});
