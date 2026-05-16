// Run: npx tsx src/viewport/bake/hydraulic.glsl.test.ts
import { strict as assert } from "node:assert";
import * as G from "./hydraulic.glsl";
const frags = [G.RAIN_FRAG,G.FLUX_FRAG,G.WATER_FRAG,G.ERODE_FRAG,G.ADVECT_FRAG,G.EVAP_FRAG,G.THERMAL_FRAG];
for (const f of frags) {
  assert.equal(typeof f, "string");
  assert.ok(f.length > 50, "frag non-trivial");
  assert.ok(!f.includes("`"), "NO backticks in GLSL");
  assert.ok(f.includes("out vec4 fragColor"), "declares fragColor out");
  assert.ok(f.includes("void main"), "has main");
  assert.ok(/precision\s+highp\s+float/.test(f), "has precision");
}
// every declared uniform is one-per-line, no trailing comment on decl line
for (const f of frags)
  for (const line of f.split("\n"))
    if (line.trim().startsWith("uniform "))
      assert.ok(!line.includes("//"), "no comment on uniform decl line: " + line);
console.log("ok");
