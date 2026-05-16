// Run: npx tsx src/viewport/bake/erodePipeline.test.ts
//
// Task A15 — GPU pyramid orchestrator.
//
// No headless WebGL in this repo: the ONLY unit-testable surface here is the
// pure level-schedule logic (`pyramidSchedule`). GPU correctness is gated by
// the A18 CPU↔GPU parity harness + A19 visual validation, NOT here.
//
// `pyramidSchedule(cfg)` returns the per-level face resolutions coarse→fine.
// Mirrors `run_pyramid_core`: the start field is `cfg.base_face_res`, and each
// level multiplies the face res by 2 (`upsample2x`), `pyramid_levels` entries.

import assert from "node:assert/strict";
import { pyramidSchedule } from "./erodePipeline";

// Canonical case from the plan (Task A15, Step 1).
const s = pyramidSchedule({ baseFaceRes: 64, pyramidLevels: 5 } as never);
assert.deepEqual(
  s.map((x) => x.faceRes),
  [64, 128, 256, 512, 1024],
  "5 levels from base 64: 64,128,256,512,1024 (faceRes = base*2^level)",
);

// Single-level pyramid: just the base res, no upsample.
const s1 = pyramidSchedule({ baseFaceRes: 32, pyramidLevels: 1 } as never);
assert.deepEqual(
  s1.map((x) => x.faceRes),
  [32],
  "1 level: only the base res",
);

// pyramid_levels is `.max(1)` in the Rust core — 0 levels clamps to 1.
const s0 = pyramidSchedule({ baseFaceRes: 64, pyramidLevels: 0 } as never);
assert.deepEqual(
  s0.map((x) => x.faceRes),
  [64],
  "0 levels clamps to 1 (Rust: cfg.pyramid_levels.max(1))",
);

// base_face_res is `.max(1)` in the Rust core.
const sb = pyramidSchedule({ baseFaceRes: 0, pyramidLevels: 3 } as never);
assert.deepEqual(
  sb.map((x) => x.faceRes),
  [1, 2, 4],
  "0 base clamps to 1 (Rust: cfg.base_face_res.max(1))",
);

// A deeper default-shaped pyramid.
const sd = pyramidSchedule({ baseFaceRes: 64, pyramidLevels: 6 } as never);
assert.deepEqual(
  sd.map((x) => x.faceRes),
  [64, 128, 256, 512, 1024, 2048],
  "6 levels from base 64 reach 2048",
);

console.log("ok");
