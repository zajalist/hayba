import { describe, it, expect, beforeEach } from "vitest";
import {
  earthElevations,
  __resetEarthCache,
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
