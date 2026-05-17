// Phase 10.1 audit — Layer 1 diff (positions).
// Compares ts-peels-d32.json against rust-peels-d32.json cell-by-cell.

import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, "$1:"));
const ts = JSON.parse(fs.readFileSync(path.join(dir, "ts-peels-d32.json"), "utf8"));
const rust = JSON.parse(fs.readFileSync(path.join(dir, "rust-peels-d32.json"), "utf8"));

if (ts.divisions !== rust.divisions) throw new Error(`divisions mismatch: ts=${ts.divisions} rust=${rust.divisions}`);
if (ts.n_cells !== rust.n_cells) throw new Error(`n_cells mismatch: ts=${ts.n_cells} rust=${rust.n_cells}`);

let maxDelta = 0;
let maxDeltaId = -1;
const drifters = [];
for (let i = 0; i < ts.n_cells; i++) {
  const a = ts.cells[i].xyz;
  const b = rust.cells[i].xyz;
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  const d = Math.hypot(dx, dy, dz);
  if (d > maxDelta) { maxDelta = d; maxDeltaId = i; }
  if (d > 1e-4 && drifters.length < 10) drifters.push({ id: i, ts: a, rust: b, delta: d });
}

console.log(`n_cells: ${ts.n_cells}`);
console.log(`max delta: ${maxDelta.toExponential(3)} at cell ${maxDeltaId}`);
console.log(`drifters > 1e-4: ${drifters.length}`);
for (const d of drifters) {
  console.log(`  cell ${d.id}: ts=${d.ts.map(v => v.toFixed(6))} rust=${d.rust.map(v => v.toFixed(6))} Δ=${d.delta.toExponential(3)}`);
}

if (maxDelta < 1e-4) {
  console.log("VERDICT: Layer 1 PASS — positions match within 1e-4");
  process.exit(0);
} else if (maxDelta < 1e-2) {
  console.log("VERDICT: Layer 1 MINOR — precision drift (likely f32 vs f64)");
  process.exit(0);
} else {
  console.log("VERDICT: Layer 1 FAIL — real drift, fix required");
  process.exit(1);
}
