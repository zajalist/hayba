// Run: npx tsx src/viewport/bake/hydraulic.test.ts
import { strict as assert } from "node:assert";
import { DEFAULT_HYDRAULIC, planSteps } from "./hydraulic";
// Macro-preserving tuning (2026-05-16): the worst-case cumulative bedrock
// travel is bounded by steps*maxDeltaB; it MUST stay well below the painted
// continent's ~0.8 peak relief so erosion carves valleys without planing the
// macro silhouette (was 200*0.004=0.80 = full relief -> ring-basin bug).
assert.equal(DEFAULT_HYDRAULIC.steps, 100);
assert.ok(DEFAULT_HYDRAULIC.kc > 0 && DEFAULT_HYDRAULIC.maxDeltaB > 0);
assert.ok(
  DEFAULT_HYDRAULIC.steps * DEFAULT_HYDRAULIC.maxDeltaB <= 0.25,
  "steps*maxDeltaB must stay <= ~25% of peak relief (macro-preservation)",
);
const p = planSteps({ ...DEFAULT_HYDRAULIC, steps: 50, chunk: 16 });
assert.equal(p.totalSteps, 50);
assert.equal(p.chunks.reduce((a,b)=>a+b,0), 50);
assert.ok(p.chunks.every(c => c <= 16 && c > 0));
assert.equal(p.chunks.length, 4); // 16+16+16+2
console.log("ok");
