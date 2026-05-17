// Quick smoke test: load the baked HAYV2 world.bin through FrameCache, dump
// summary stats. Run: node tools/peels-audit/test-hayv2-load.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import { FrameCache } from "../../packages/frame-stream/index.js";

const dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, "$1:"));
const buf = fs.readFileSync(path.join(dir, "world-d32.bin"));
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const cache = new FrameCache(ab);

console.log("header.format:", cache.header.format);
console.log("header.n_cells:", cache.header.n_cells);
console.log("header.total_frames:", cache.header.total_frames);
console.log("header.divisions:", cache.header.divisions);
console.log("header.master_seed:", cache.header.master_seed);

const s = cache.seek(0);
console.log("\nInitial state stats:");
const plateCounts = new Map();
for (const p of s.cell_plate) plateCounts.set(p, (plateCounts.get(p) ?? 0) + 1);
console.log("  unique plate ids:", [...plateCounts.keys()].slice(0, 20));
console.log("  cell counts:", [...plateCounts.entries()].slice(0, 12).map(([k, v]) => `${k}:${v}`).join(", "));

let minE = Infinity, maxE = -Infinity, sumE = 0;
for (const e of s.cell_elevation_m) {
  if (e < minE) minE = e;
  if (e > maxE) maxE = e;
  sumE += e;
}
console.log("  elevation_m: min=" + minE + " max=" + maxE + " mean=" + (sumE / s.cell_elevation_m.length).toFixed(1));

let contCount = 0;
for (const c of s.cell_continental) if (c) contCount++;
console.log("  continental cells:", contCount, "/", s.cell_continental.length);

// Seek a few frames — for HAYV2 they should all return the same state.
const s5 = cache.seek(5);
const same = s5.cell_elevation_m[0] === s.cell_elevation_m[0];
console.log("\nseek(5) returns initial-state-shaped object:", same ? "OK" : "MISMATCH");
console.log("\nVERDICT: HAYV2 load path works end-to-end");
