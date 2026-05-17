// Run: npx tsx src/wizard/paint/brushes.test.ts
import assert from "node:assert/strict";
import { applyMode, valueNoise, fbm, type BrushMode } from "./brushes";

function approx(a: number, b: number, eps = 1e-6): void {
  assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);
}

// raise increases elevation by w * 0.05
approx(applyMode({ mode: "raise", current: 0, w: 1, neighborAvg: 0, flattenTarget: 0, noiseSample: 0 }), 0.05);
approx(applyMode({ mode: "raise", current: 0.1, w: 0.5, neighborAvg: 0, flattenTarget: 0, noiseSample: 0 }), 0.125);

// lower decreases
approx(applyMode({ mode: "lower", current: 0.2, w: 1, neighborAvg: 0, flattenTarget: 0, noiseSample: 0 }), 0.15);

// smooth lerps toward neighborAvg
approx(applyMode({ mode: "smooth", current: 0.0, w: 0.5, neighborAvg: 0.4, flattenTarget: 0, noiseSample: 0 }), 0.2);

// flatten lerps toward target
approx(applyMode({ mode: "flatten", current: 0.0, w: 1.0, neighborAvg: 0, flattenTarget: 0.7, noiseSample: 0 }), 0.7);
approx(applyMode({ mode: "flatten", current: 0.5, w: 0.0, neighborAvg: 0, flattenTarget: -1, noiseSample: 0 }), 0.5);

// noise adds w * 0.05 * (sample - 0.5)
approx(applyMode({ mode: "noise", current: 0.2, w: 1.0, neighborAvg: 0, flattenTarget: 0, noiseSample: 1.0 }), 0.2 + 0.025);
approx(applyMode({ mode: "noise", current: 0.2, w: 1.0, neighborAvg: 0, flattenTarget: 0, noiseSample: 0.0 }), 0.2 - 0.025);

// w = 0 is a no-op for every mode
for (const m of ["raise", "lower", "smooth", "flatten", "noise"] as BrushMode[]) {
  approx(
    applyMode({ mode: m, current: 0.3, w: 0, neighborAvg: 0.9, flattenTarget: -0.5, noiseSample: 0.7 }),
    0.3,
  );
}

// valueNoise is deterministic
{
  const a = valueNoise(1.2, 3.4, 5.6, 42);
  const b = valueNoise(1.2, 3.4, 5.6, 42);
  approx(a, b);
}

// fbm produces values in [0, 1] for a few sample points
for (let i = 0; i < 10; i++) {
  const v = fbm(i * 0.7, i * 1.3, i * 0.5, 4, 42);
  assert.ok(v >= 0 && v <= 1, `fbm out of range: ${v}`);
}

console.log("brushes.test.ts ✓");
