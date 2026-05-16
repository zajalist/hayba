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
import { pyramidSchedule, erodeAccumPassBudget } from "./erodePipeline";

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

// --- §6 HARDENING: hierarchical coarse→fine accumulation is TDR-feasible.
// The PROHIBITED flat scheme ran ~6·n² Jacobi passes at EVERY level for
// EACH of 3 accumulations × 16 K-iters. At the production schedule
// (base 64, 5 levels → finest n=1024, 16 K-iters) that is, just for the
// finest level's stream-power accumulation:
//   6·1024² · 16  ≈ 1.0e8  passes  (×3 accumulations ≈ 3e8, +PD fills).
const FLAT_FINEST_ONE_ACCUM = 6 * 1024 * 1024 * 16;
assert.ok(
  FLAT_FINEST_ONE_ACCUM > 1e8,
  "sanity: the OLD flat scheme was >1e8 passes at the finest level alone",
);

// The hierarchical warm-start budget for the SAME production config must
// be ~thousands (only level 0, the smallest n=64, pays a from-scratch
// O(6·n²); every finer level is O(1)-refine + an O(8·n) PD fill).
const prodBudget = erodeAccumPassBudget({
  baseFaceRes: 64,
  pyramidLevels: 5,
  kItersPerLevel: 16,
});
assert.ok(
  prodBudget < 200_000,
  `hierarchical budget must be ~thousands, not ~1e8 (got ${prodBudget})`,
);
assert.ok(
  prodBudget < FLAT_FINEST_ONE_ACCUM / 1000,
  `hierarchical budget must be >1000x cheaper than the old flat scheme ` +
    `(got ${prodBudget} vs flat-finest-one-accum ${FLAT_FINEST_ONE_ACCUM})`,
);

// The ONLY O(6·n²) term is level 0 at the base res (n=64): 6·64²+64 =
// 24640, ×3 accumulations for K-iter 0 only ≈ 73920; the other 15
// K-iters × 3 accums × 4 levels ... are all the constant refine cap (16).
// So the whole production bake is well under 100k accumulation passes.
assert.ok(
  prodBudget > 6 * 64 * 64, // must at least include the one cold base relax
  `budget must include the level-0 cold from-scratch relax (got ${prodBudget})`,
);

// Single-level (no upsample) config still bounded (only the cold caps).
const oneLevel = erodeAccumPassBudget({
  baseFaceRes: 64,
  pyramidLevels: 1,
  kItersPerLevel: 16,
});
assert.ok(
  oneLevel < 200_000 && oneLevel > 0,
  `1-level budget bounded (got ${oneLevel})`,
);

console.log("ok");
