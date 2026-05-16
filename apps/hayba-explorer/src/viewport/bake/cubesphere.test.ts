// Run: npx tsx src/viewport/bake/cubesphere.test.ts
//
// Parity test for the TS cube-sphere mirror (Task A13). This module MUST be a
// formula-identical port of the committed Rust oracle
//   apps/hayba-explorer/src-tauri/src/erosion/cubesphere.rs
// so the GPU port (A15) produces the same results as the CPU oracle and A18's
// CPU↔GPU parity harness holds.
//
// Coverage:
//   1. Spec roundtrip: p=[0.3,0.7,-0.2] normalized, dot(q,u) > 0.9999.
//   2. Parity-flavoured roundtrip across all 6 faces (several unit vectors).
//   3. FACE_NEI / faceNeighbours match the empirically-verified Rust table
//      VERBATIM ([[5,4,2,3],[4,5,2,3],[0,1,5,4],[0,1,4,5],[0,1,2,3],[1,0,2,3]]).
//   4. unwarp(warp(a)) ≈ a — pins the corrected `4/π` inverse (NOT `2/π`;
//      `2/π` would fail this check for nonzero `a`).
//   5. cornerJunctions() — 8 corners, each 3 distinct faces, matching Rust.
import assert from "node:assert/strict";
import {
  sphereToFaceUv,
  faceUvToSphere,
  FACE_NEI,
  faceNeighbours,
  cornerJunctions,
  warp,
  unwarp,
} from "./cubesphere";

type V3 = [number, number, number];
const norm = (p: V3): V3 => {
  const n = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / n, p[1] / n, p[2] / n];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// --- 1. Spec roundtrip (plan A13 Step 1 verbatim) -----------------------
{
  const p: V3 = [0.3, 0.7, -0.2];
  const n = Math.hypot(...p);
  const u: V3 = [p[0] / n, p[1] / n, p[2] / n];
  const { face, u: fu, v: fv } = sphereToFaceUv(u);
  const q = faceUvToSphere(face, fu, fv);
  assert.ok(q[0] * u[0] + q[1] * u[1] + q[2] * u[2] > 0.9999, "roundtrip");
}

// --- 2. Parity-flavoured roundtrip across all 6 faces -------------------
// One strongly-axis-aligned vector per face plus several oblique vectors;
// every roundtrip must close to dot > 0.9999.
{
  const samples: V3[] = [
    [1, 0.2, -0.15], // +X dominant
    [-1, -0.1, 0.3], // -X dominant
    [0.2, 1, -0.25], // +Y dominant
    [0.15, -1, 0.2], // -Y dominant
    [-0.2, 0.3, 1], // +Z dominant
    [0.25, -0.15, -1], // -Z dominant
    [0.3, 0.7, -0.2],
    [-0.9, 0.1, 0.4],
    [0, 1, 0],
    [0.5, -0.5, 0.5],
    [-0.33, -0.66, -0.11],
  ];
  for (const s of samples) {
    const u = norm(s);
    const { face, u: fu, v: fv } = sphereToFaceUv(u);
    const q = faceUvToSphere(face, fu, fv);
    assert.ok(
      dot(q, u) > 0.9999,
      `roundtrip drift for ${JSON.stringify(s)} -> face ${face}, dot=${dot(q, u)}`,
    );
  }
}

// --- 3. FACE_NEI matches the committed Rust table VERBATIM --------------
// Rust: [[5,4,2,3],[4,5,2,3],[0,1,5,4],[0,1,4,5],[0,1,2,3],[1,0,2,3]]
// faces: 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z; entry order = right,left,up,down.
{
  const expected = [
    [5, 4, 2, 3],
    [4, 5, 2, 3],
    [0, 1, 5, 4],
    [0, 1, 4, 5],
    [0, 1, 2, 3],
    [1, 0, 2, 3],
  ];
  assert.deepEqual(FACE_NEI, expected, "FACE_NEI must equal the Rust table");
  for (let f = 0; f < 6; f++) {
    assert.deepEqual(
      faceNeighbours(f),
      expected[f],
      `faceNeighbours(${f}) must equal FACE_NEI[${f}]`,
    );
    // Same invariants the Rust test enforces: 4 distinct, none == f.
    const set = new Set(faceNeighbours(f));
    assert.equal(set.size, 4, `face ${f} has duplicate neighbours`);
    assert.ok(!set.has(f), `face ${f} lists itself as a neighbour`);
  }
}

// --- 4. unwarp(warp(a)) ≈ a — pins the 4/π inverse (NOT 2/π) ------------
// With unwarp = atan(a) * 4/π and warp = tan(a * π/4), the composition is the
// identity. If unwarp used 2/π (the historical bug), unwarp(warp(0.3)) would
// be ≈0.15, failing this assertion.
{
  for (const a of [-1, -0.5, 0, 0.3, 1]) {
    const back = unwarp(warp(a));
    assert.ok(
      Math.abs(back - a) < 1e-6,
      `unwarp(warp(${a})) = ${back}, expected ≈ ${a} (4/π inverse)`,
    );
  }
  // Explicitly assert the 2/π bug would NOT roundtrip (guards against regression).
  const bug = Math.atan(warp(0.3)) * (2.0 / Math.PI);
  assert.ok(
    Math.abs(bug - 0.3) > 0.1,
    "sanity: 2/π inverse must NOT roundtrip (it would be ≈0.15)",
  );
}

// --- 5. cornerJunctions() mirrors the Rust static topology -------------
{
  const corners = cornerJunctions();
  assert.equal(corners.length, 8, "expected 8 cube corners");
  const expectedCorners = [
    [0, 2, 4],
    [0, 2, 5],
    [0, 3, 4],
    [0, 3, 5],
    [1, 2, 4],
    [1, 2, 5],
    [1, 3, 4],
    [1, 3, 5],
  ];
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(
      corners[i].faces,
      expectedCorners[i],
      `corner ${i} faces`,
    );
    const [a, b, c] = corners[i].faces;
    assert.ok(a !== b && b !== c && a !== c, `corner ${i} has duplicate faces`);
  }
}

console.log("ok");
