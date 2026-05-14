// Phase 10.1 audit harness — dumps TS peels per-cell (id, xyz, neighbors).
// Run with: npx tsx tools/peels-audit/dump-ts-peels.ts [divisions]
//
// peels Field positions are (phi, lambda) = (lat, lon) in radians on a
// unit sphere. We emit xyz in the Rust/Three.js Y-up convention so the
// Layer-1 diff is apples-to-apples:
//   x = cos(phi) * cos(lambda)
//   y = sin(phi)                  // poles on Y
//   z = cos(phi) * sin(lambda)
//
// Neighbor order (peels canonical, from Field.adjacents()):
//   pole cells (index 0 = N, 1 = S) have 5 neighbors (pentagons).
//   all others have 6 neighbors (hexagons).
//   Field.adjacents() returns an array indexed by the 6 cardinal-ish slots
//   (0..5); the unused slot for pentagons is `undefined` / null.

import Sphere from "../../tectonic-explorer/packages/tecrock-simulation/src/peels/sphere/index";
import * as fs from "node:fs";
import * as path from "node:path";

const divisions = parseInt(process.argv[2] ?? "32", 10);

const sphere: any = new Sphere({ divisions });
const fields: any[] = sphere.fields;
const n = fields.length;

const out: Array<{ id: number; xyz: [number, number, number]; neighbors: (number | null)[] }> = [];
for (let i = 0; i < n; i++) {
  const f = fields[i];
  const pos = f.position; // Float64Array(2) — [phi, lambda]
  const phi = pos[0];
  const lambda = pos[1];
  const x = Math.cos(phi) * Math.cos(lambda);
  const y = Math.sin(phi);
  const z = Math.cos(phi) * Math.sin(lambda);
  const adj = f.adjacents() as any[];
  const neighbors: (number | null)[] = [];
  for (let p = 0; p < 6; p++) {
    const nb = adj[p];
    neighbors.push(nb == null ? null : nb._i);
  }
  out.push({ id: i, xyz: [x, y, z], neighbors });
}

const outPath = path.join(__dirname, `ts-peels-d${divisions}.json`);
fs.writeFileSync(outPath, JSON.stringify({ divisions, n_cells: n, cells: out }));
console.error(`wrote ${outPath} (${n} cells, divisions=${divisions})`);
// Spot-check first 5
for (let i = 0; i < 5; i++) {
  const c = out[i];
  const mag = Math.hypot(...c.xyz);
  console.error(`  cell ${c.id}: xyz=[${c.xyz.map(v => v.toFixed(4)).join(", ")}] |xyz|=${mag.toFixed(6)} neighbors=${c.neighbors.join(",")}`);
}
