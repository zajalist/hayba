// Run: npx tsx src/viewport/bake/hydraulic.test.ts
import { strict as assert } from "node:assert";
import { DEFAULT_HYDRAULIC, planSteps } from "./hydraulic";
assert.equal(DEFAULT_HYDRAULIC.steps, 200);
assert.ok(DEFAULT_HYDRAULIC.kc > 0 && DEFAULT_HYDRAULIC.maxDeltaB > 0);
const p = planSteps({ ...DEFAULT_HYDRAULIC, steps: 50, chunk: 16 });
assert.equal(p.totalSteps, 50);
assert.equal(p.chunks.reduce((a,b)=>a+b,0), 50);
assert.ok(p.chunks.every(c => c <= 16 && c > 0));
assert.equal(p.chunks.length, 4); // 16+16+16+2
console.log("ok");
