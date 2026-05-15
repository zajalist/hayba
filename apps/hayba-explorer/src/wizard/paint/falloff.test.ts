// Run: npx tsx src/wizard/paint/falloff.test.ts
import assert from "node:assert/strict";
import { falloff, type FalloffKind } from "./falloff";

function approx(a: number, b: number, eps = 1e-6): void {
  assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);
}

// At d=0 every falloff returns 1
for (const k of ["linear", "smooth", "hard"] as FalloffKind[]) {
  approx(falloff(k, 0), 1);
}

// At d>=1 every falloff returns 0
for (const k of ["linear", "smooth", "hard"] as FalloffKind[]) {
  approx(falloff(k, 1), 0);
  approx(falloff(k, 1.5), 0);
}

// Linear at d=0.5 → 0.5
approx(falloff("linear", 0.5), 0.5);

// Smooth at d=0.5 is between 0.4 and 0.6 (smoothstep-ish)
const s = falloff("smooth", 0.5);
assert.ok(s > 0.4 && s < 0.6, `smooth(0.5) = ${s}`);

// Hard is 1 everywhere inside disc except at edge
approx(falloff("hard", 0.9), 1);
approx(falloff("hard", 0.999), 1);

console.log("falloff.test.ts ✓");
