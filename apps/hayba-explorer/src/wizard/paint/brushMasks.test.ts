// Run: npx tsx src/wizard/paint/brushMasks.test.ts
import assert from "node:assert/strict";
import { sampleMask, MASK_NAMES, type MaskName } from "./brushMasks";

// Every named mask must accept (0, 0) (center) and (1, 1) (corner) without throwing
for (const name of MASK_NAMES) {
  const c = sampleMask(name, 0, 0);
  const e = sampleMask(name, 1, 1);
  assert.ok(c >= 0 && c <= 1, `${name} center = ${c}`);
  assert.ok(e >= 0 && e <= 1, `${name} corner = ${e}`);
}

// round-soft: center > edge
{
  const c = sampleMask("round-soft", 0, 0);
  const e = sampleMask("round-soft", 0.95, 0);
  assert.ok(c > e, `round-soft: center ${c} should exceed edge ${e}`);
  assert.ok(c > 0.9, `round-soft center should be near 1 (got ${c})`);
}

// round-hard: 1 inside, 0 outside
{
  assert.ok(sampleMask("round-hard", 0, 0) > 0.99);
  assert.ok(sampleMask("round-hard", 0.5, 0) > 0.99);
  assert.ok(sampleMask("round-hard", 1.01, 0) < 0.01);
}

// Out-of-bounds sampling returns 0
{
  assert.equal(sampleMask("round-soft", 2, 2), 0);
  assert.equal(sampleMask("round-soft", -2, 0), 0);
}

// ridge: stronger along one axis than perpendicular
{
  const along = sampleMask("ridge", 0, 0.3);
  const perp  = sampleMask("ridge", 0.3, 0);
  assert.ok(along > perp, `ridge along ${along} vs perp ${perp}`);
}

console.log("brushMasks.test.ts ✓");
