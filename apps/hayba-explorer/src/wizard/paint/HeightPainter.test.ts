// Run: npx tsx src/wizard/paint/HeightPainter.test.ts
import assert from "node:assert/strict";
import { HeightPainter, type BrushConfig } from "./HeightPainter";

const NORTH: [number, number, number] = [0, 1, 0];
const RING_LAT_RAD = (Math.PI / 2) - 0.5;
const positions: [number, number, number][] = [NORTH];
for (let i = 0; i < 6; i++) {
  const lon = (i / 6) * Math.PI * 2;
  positions.push([
    Math.cos(RING_LAT_RAD) * Math.cos(lon),
    Math.sin(RING_LAT_RAD),
    Math.cos(RING_LAT_RAD) * Math.sin(lon),
  ]);
}
const neighbours: number[][] = [
  [1, 2, 3, 4, 5, 6],
  [0, 2, 6], [0, 1, 3], [0, 2, 4], [0, 3, 5], [0, 4, 6], [0, 5, 1],
];

function defaultBrush(overrides: Partial<BrushConfig> = {}): BrushConfig {
  return {
    mode: "raise",
    radiusRad: 0.01,
    strength: 1.0,
    falloff: "hard",
    mask: "round-hard",
    flattenTarget: 0,
    noiseScale: 4,
    ...overrides,
  };
}

function fresh(): HeightPainter {
  return new HeightPainter({ positions, neighbours, seed: 42, baseline: new Float32Array(7) });
}

// Basic stroke
{
  const p = fresh();
  p.beginStroke(defaultBrush());
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  const { painted_elevations, painted_mask } = p.toDraftFields();
  assert.equal(painted_mask[0], 1);
  assert.ok(painted_elevations[0] > 0, `expected raise, got ${painted_elevations[0]}`);
  for (let i = 1; i < 7; i++) assert.equal(painted_mask[i], 0);
}

// Strength = 0 is no-op
{
  const p = fresh();
  p.beginStroke(defaultBrush({ strength: 0 }));
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  const { painted_elevations, painted_mask } = p.toDraftFields();
  assert.equal(painted_mask[0], 0);
  assert.equal(painted_elevations[0], 0);
}

// Undo restores pre-stroke state
{
  const p = fresh();
  p.beginStroke(defaultBrush({ radiusRad: 1.0, mask: "round-hard", falloff: "hard" }));
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  p.undo();
  const { painted_elevations, painted_mask } = p.toDraftFields();
  for (let i = 0; i < 7; i++) {
    assert.equal(painted_mask[i], 0);
    assert.equal(painted_elevations[i], 0);
  }
}

// Redo restores post-stroke state
{
  const p = fresh();
  p.beginStroke(defaultBrush());
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  const before = p.toDraftFields().painted_elevations[0];
  p.undo();
  p.redo();
  assert.equal(p.toDraftFields().painted_elevations[0], before);
}

// New stroke after undo clears redo
{
  const p = fresh();
  p.beginStroke(defaultBrush());
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  p.undo();
  p.beginStroke(defaultBrush());
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  assert.equal(p.redo(), false);
}

// Ring capacity = 20
{
  const p = fresh();
  for (let i = 0; i < 21; i++) {
    p.beginStroke(defaultBrush());
    p.tickStroke({ seedCellId: 0, hit: NORTH });
    p.endStroke();
  }
  for (let i = 0; i < 20; i++) assert.equal(p.undo(), true);
  assert.equal(p.undo(), false);
}

// Reset clears everything
{
  const p = fresh();
  p.beginStroke(defaultBrush());
  p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  p.reset();
  const { painted_elevations, painted_mask } = p.toDraftFields();
  for (let i = 0; i < 7; i++) {
    assert.equal(painted_mask[i], 0);
    assert.equal(painted_elevations[i], 0);
  }
  assert.equal(p.undo(), false);
}

// Smooth converges toward neighbour mean
{
  const p = fresh();
  p.beginStroke(defaultBrush({ radiusRad: 1.0, strength: 1.0, mode: "raise" }));
  // Each raise tick adds w*PER_TICK_DELTA = 1*0.05; drive neighbours to the +1 clamp
  // so the neighbour mean is high enough to detect convergence past 0.7.
  for (let i = 0; i < 25; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  p.beginStroke(defaultBrush({ radiusRad: 0.01, mode: "flatten", flattenTarget: 0 }));
  for (let i = 0; i < 5; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  p.beginStroke(defaultBrush({ radiusRad: 0.01, mode: "smooth", strength: 1.0 }));
  for (let i = 0; i < 20; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  const e0 = p.toDraftFields().painted_elevations[0];
  assert.ok(e0 > 0.7, `smooth should converge toward neighbour mean, got ${e0}`);
}

// Clamping to [-1, +1]
{
  const p = fresh();
  p.beginStroke(defaultBrush({ strength: 1.0, mode: "raise" }));
  for (let i = 0; i < 200; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  assert.equal(p.toDraftFields().painted_elevations[0], 1);

  p.beginStroke(defaultBrush({ strength: 1.0, mode: "lower" }));
  for (let i = 0; i < 500; i++) p.tickStroke({ seedCellId: 0, hit: NORTH });
  p.endStroke();
  assert.equal(p.toDraftFields().painted_elevations[0], -1);
}

console.log("HeightPainter.test.ts ✓");
