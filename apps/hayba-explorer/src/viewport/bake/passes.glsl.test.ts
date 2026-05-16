// Run: npx tsx src/viewport/bake/passes.glsl.test.ts
//
// Task A14 — GLSL pass library shape / footgun guard.
//
// GLSL itself is NOT numerically unit-tested here (A18 CPU↔GPU parity +
// A19 visual validation do that). This test only pins:
//   1. Every exported value is a string containing `void main` (it really
//      is a fragment shader, not a stray helper/const).
//   2. ZERO backtick characters appear anywhere in any GLSL string. The
//      `.glsl.ts` file stores GLSL inside JS template literals; a single
//      stray backtick inside the GLSL silently terminates the literal and
//      corrupts every downstream shader. This is the #1 footgun in this
//      codebase — guard it hard.
//   3. The NORMATIVE shared chunks the spec mandates are present where
//      required (substring asserts on the relevant exported sources):
//        - `tap2D`        : the OES_texture_float_linear 4-tap fallback (A12)
//        - `cornerSlope3` : the 3-vertex plane fit for the 3-way cube corners
//        - `fillPits`     : the §5.4/A9 monotonic-downhill enforcement
//        - `neighbourTexel` + `faceTexelToSpherePos` : seam/corner-correct
//          shared addressing chunk.

import assert from "node:assert/strict";
import * as P from "./passes.glsl";

// (1) + (2): every export is a backtick-free shader string.
for (const [k, v] of Object.entries(P)) {
  assert.ok(
    typeof v === "string" && v.includes("void main"),
    `${k} is a shader (string containing "void main")`,
  );
  assert.ok(
    !v.includes("`"),
    `${k}: no backtick in GLSL (breaks the .glsl.ts template literal)`,
  );
}

// (3) NORMATIVE shared-chunk presence. These helpers are composed into the
// pass sources via string concatenation; assert by substring on the passes
// that must contain them.
const {
  DETAIL_BAND_FRAG,
  STREAM_POWER_FRAG,
  THERMAL_FRAG,
  UPSAMPLE_FRAG,
  RESAMPLE_FRAG,
} = P as Record<string, string>;

// Every pass must carry the seam/corner-correct shared addressing chunk.
for (const [name, src] of [
  ["DETAIL_BAND_FRAG", DETAIL_BAND_FRAG],
  ["STREAM_POWER_FRAG", STREAM_POWER_FRAG],
  ["THERMAL_FRAG", THERMAL_FRAG],
  ["UPSAMPLE_FRAG", UPSAMPLE_FRAG],
  ["RESAMPLE_FRAG", RESAMPLE_FRAG],
] as const) {
  assert.ok(
    typeof src === "string" && src.length > 0,
    `${name} is exported and non-empty`,
  );
  assert.ok(
    src.includes("faceTexelToSpherePos"),
    `${name}: contains shared faceTexelToSpherePos chunk`,
  );
}

// neighbourTexel: required by the steps that walk the seam-correct topology.
for (const [name, src] of [
  ["STREAM_POWER_FRAG", STREAM_POWER_FRAG],
  ["THERMAL_FRAG", THERMAL_FRAG],
  ["UPSAMPLE_FRAG", UPSAMPLE_FRAG],
] as const) {
  assert.ok(
    src.includes("neighbourTexel"),
    `${name}: contains seam/corner-correct neighbourTexel chunk`,
  );
}

// cornerSlope3: the 3-vertex plane fit used by stream-power + thermal at the
// 8 cube corners (corner_neighbour_count == 3).
for (const [name, src] of [
  ["STREAM_POWER_FRAG", STREAM_POWER_FRAG],
  ["THERMAL_FRAG", THERMAL_FRAG],
] as const) {
  assert.ok(
    src.includes("cornerSlope3"),
    `${name}: contains cornerSlope3 3-vertex plane-fit chunk`,
  );
}

// tap2D: the manual 4-tap bilinear fallback gated by uManualBilinear (A12).
for (const [name, src] of [
  ["UPSAMPLE_FRAG", UPSAMPLE_FRAG],
  ["RESAMPLE_FRAG", RESAMPLE_FRAG],
] as const) {
  assert.ok(
    src.includes("tap2D"),
    `${name}: contains tap2D 4-tap manual-bilinear helper`,
  );
  assert.ok(
    src.includes("uManualBilinear"),
    `${name}: tap2D gated by uManualBilinear`,
  );
}

// fillPits: the A9 §5.4 monotonic-downhill enforcement, applied to h in the
// upsample pass before conserved water/sed are placed.
assert.ok(
  UPSAMPLE_FRAG.includes("fillPits"),
  "UPSAMPLE_FRAG: contains fillPits monotonic-downhill chunk",
);

console.log("ok");
