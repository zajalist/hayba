// Run: npx tsx src/viewport/bake/hydraulic.test.ts
import { strict as assert } from "node:assert";
import { DEFAULT_HYDRAULIC, planSteps } from "./hydraulic";
// S1 metre-denominated model (2026-05-16): the old per-step maxDeltaB
// clamp + uplift are removed. Strength is now physical (incision against
// the true metre slope, integrated over `steps`). `strength` is small so
// the bake is gentle ("not way too strong"); macro preservation in S1 is
// the gentle physics + ocean early-return until S2's band split lands.
assert.equal(DEFAULT_HYDRAULIC.steps, 100);
assert.ok(DEFAULT_HYDRAULIC.kc > 0 && DEFAULT_HYDRAULIC.strength > 0);
assert.ok(
  !("maxDeltaB" in DEFAULT_HYDRAULIC) && !("uplift" in DEFAULT_HYDRAULIC),
  "S1 removes the maxDeltaB clamp + uplift term",
);
assert.ok(
  DEFAULT_HYDRAULIC.strength < 0.2,
  "strength must stay small (not way too strong)",
);
const p = planSteps({ ...DEFAULT_HYDRAULIC, steps: 50, chunk: 16 });
assert.equal(p.totalSteps, 50);
assert.equal(p.chunks.reduce((a,b)=>a+b,0), 50);
assert.ok(p.chunks.every(c => c <= 16 && c > 0));
assert.equal(p.chunks.length, 4); // 16+16+16+2
console.log("ok");
