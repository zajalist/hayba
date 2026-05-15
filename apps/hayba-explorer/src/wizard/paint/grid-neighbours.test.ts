// Run: npx tsx src/wizard/paint/grid-neighbours.test.ts
import assert from "node:assert/strict";
import { cellsInRadius } from "./grid-neighbours";

// Synthetic 7-cell flower: cell 0 at north pole, 6 cells in a ring at ~30°.
const NORTH: [number, number, number] = [0, 1, 0];
const RING_LAT_RAD = (Math.PI / 2) - 0.5; // sin = ~0.479, ~30° from north
const ringPositions: [number, number, number][] = [];
for (let i = 0; i < 6; i++) {
  const lon = (i / 6) * Math.PI * 2;
  ringPositions.push([
    Math.cos(RING_LAT_RAD) * Math.cos(lon),
    Math.sin(RING_LAT_RAD),
    Math.cos(RING_LAT_RAD) * Math.sin(lon),
  ]);
}
const positions: [number, number, number][] = [NORTH, ...ringPositions];
// Adjacency: center connects to all ring cells; ring cells connect to center + 2 ring siblings.
const neighbours: number[][] = [
  [1, 2, 3, 4, 5, 6],
  [0, 2, 6], [0, 1, 3], [0, 2, 4], [0, 3, 5], [0, 4, 6], [0, 5, 1],
];

// Tiny radius — only the seed cell.
{
  const out = cellsInRadius({ positions, neighbours, seedCellId: 0, hit: NORTH, radiusRad: 0.01 });
  assert.equal(out.length, 1);
  assert.equal(out[0].cellId, 0);
  assert.ok(out[0].distRad < 1e-6);
}

// Radius covering all 7 — flower fully accepted.
{
  const out = cellsInRadius({ positions, neighbours, seedCellId: 0, hit: NORTH, radiusRad: 1.0 });
  assert.equal(out.length, 7);
}

// Radius that includes seed + ring (0.5 rad covers the ring at ~0.5 rad away from pole).
{
  const out = cellsInRadius({ positions, neighbours, seedCellId: 0, hit: NORTH, radiusRad: 0.6 });
  assert.equal(out.length, 7);
}

// Radius excludes ring — only seed.
{
  const out = cellsInRadius({ positions, neighbours, seedCellId: 0, hit: NORTH, radiusRad: 0.3 });
  assert.equal(out.length, 1);
}

console.log("grid-neighbours.test.ts ✓");
