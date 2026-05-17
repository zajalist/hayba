// Phase 10.1 audit — Layer 2 diff (neighbors).
// Compares per-cell neighbor arrays. Reports length / set / order mismatches.

import * as fs from "node:fs";
import * as path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, "$1:"));
const ts = JSON.parse(fs.readFileSync(path.join(dir, "ts-peels-d32.json"), "utf8"));
const rust = JSON.parse(fs.readFileSync(path.join(dir, "rust-peels-d32.json"), "utf8"));

function realLen(arr) { return arr.filter(v => v !== null).length; }
function asSet(arr) { return new Set(arr.filter(v => v !== null)); }

let lengthMismatch = 0;
let setMismatch = 0;
let orderMismatch = 0;
const examples = { length: [], set: [], order: [] };

for (let i = 0; i < ts.n_cells; i++) {
  const a = ts.cells[i].neighbors;
  const b = rust.cells[i].neighbors;
  const la = realLen(a);
  const lb = realLen(b);
  if (la !== lb) {
    lengthMismatch++;
    if (examples.length.length < 5) examples.length.push({ id: i, ts: a, rust: b });
    continue;
  }
  const sa = asSet(a);
  const sb = asSet(b);
  let sameSet = sa.size === sb.size && [...sa].every(v => sb.has(v));
  if (!sameSet) {
    setMismatch++;
    if (examples.set.length < 5) examples.set.push({ id: i, ts: a, rust: b });
    continue;
  }
  // Same set — check order.
  let sameOrder = true;
  for (let k = 0; k < 6; k++) {
    if (a[k] !== b[k]) { sameOrder = false; break; }
  }
  if (!sameOrder) {
    orderMismatch++;
    if (examples.order.length < 5) examples.order.push({ id: i, ts: a, rust: b });
  }
}

console.log(`n_cells: ${ts.n_cells}`);
console.log(`length mismatches: ${lengthMismatch}`);
console.log(`set    mismatches: ${setMismatch}`);
console.log(`order  mismatches: ${orderMismatch}`);
for (const cat of ["length", "set", "order"]) {
  if (examples[cat].length === 0) continue;
  console.log(`\n${cat} examples:`);
  for (const e of examples[cat]) {
    console.log(`  cell ${e.id}: ts=[${e.ts.join(",")}] rust=[${e.rust.join(",")}]`);
  }
}

if (lengthMismatch === 0 && setMismatch === 0) {
  if (orderMismatch === 0) console.log("\nVERDICT: Layer 2 PASS");
  else console.log("\nVERDICT: Layer 2 MINOR — neighbor sets match but order differs");
  process.exit(0);
} else {
  console.log("\nVERDICT: Layer 2 FAIL — neighbor adjacency drifts; fix required");
  process.exit(1);
}
