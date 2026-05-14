// Standalone kd-tree correctness test. Run: npx tsx src/wizard/kdtree.test.ts
//
// Builds a tree over 1000 random unit-sphere points; for 100 query points
// asserts the tree's nearest-cell matches the brute-force nearest.

import assert from "node:assert/strict";
import { buildCellKdTree, nearestCell } from "./kdtree";

function randomUnitVector(): [number, number, number] {
  // Marsaglia (1972).
  while (true) {
    const x1 = Math.random() * 2 - 1;
    const x2 = Math.random() * 2 - 1;
    const s = x1 * x1 + x2 * x2;
    if (s >= 1) continue;
    const t = 2 * Math.sqrt(1 - s);
    return [x1 * t, x2 * t, 1 - 2 * s];
  }
}

function bruteNearest(positions: Float32Array, x: number, y: number, z: number): number {
  let best = -1;
  let bestD2 = Infinity;
  for (let i = 0; i < positions.length / 3; i++) {
    const dx = positions[3 * i] - x;
    const dy = positions[3 * i + 1] - y;
    const dz = positions[3 * i + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return best;
}

const N = 1000;
const positions = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
  const [x, y, z] = randomUnitVector();
  positions[3 * i] = x;
  positions[3 * i + 1] = y;
  positions[3 * i + 2] = z;
}

const tree = buildCellKdTree(positions);
let passed = 0;
const QUERIES = 100;
for (let q = 0; q < QUERIES; q++) {
  const [x, y, z] = randomUnitVector();
  const kdHit = nearestCell(tree, x, y, z);
  const bfHit = bruteNearest(positions, x, y, z);
  assert.equal(kdHit, bfHit, `query ${q}: kd=${kdHit} brute=${bfHit}`);
  passed++;
}
console.log(`kd-tree: ${passed}/${QUERIES} queries matched brute-force`);
