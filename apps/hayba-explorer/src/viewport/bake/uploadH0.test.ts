// Run: npx tsx src/viewport/bake/uploadH0.test.ts
//
// Task A16 layout-parity test. The `uploadH0` atlas ordering MUST match
// the Rust `wizard.rs::bake_h0_v2_impl` serialisation, which in turn
// mirrors `passes.glsl.ts` GLSL_ATLAS (`srcFaceUvToAtlas`):
//
//   tileX = face % 3 ; tileY = face / 3
//   atlas uv = ( (tileX + (i+0.5)/n) / 3 , (tileY + (j+0.5)/n) / 2 )
//
// i.e. cube cell (face,i,j) → atlas pixel (tileX·n + i, tileY·n + j),
// stored row-major as atlas[y·(3n) + x]. Wrong layout silently feeds
// A15/A18 garbage h0, so this pins the pure index math (no GL).

import assert from "node:assert/strict";
import {
  ATLAS_COLS,
  ATLAS_ROWS,
  atlasDims,
  atlasIndexToXY,
  uploadH0,
  xyForFaceTexel,
} from "./uploadH0";

// --- atlasDims: 3·n × 2·n ------------------------------------------------
{
  const d = atlasDims(64);
  assert.equal(d.width, 3 * 64);
  assert.equal(d.height, 2 * 64);
}

// --- face → tile mapping (the exact GLSL convention) ---------------------
// face 0→(0,0) 1→(1,0) 2→(2,0) 3→(0,1) 4→(1,1) 5→(2,1).
{
  const n = 8;
  const expectTile: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ];
  for (let face = 0; face < 6; face++) {
    // cell (0,0) of a face sits at the tile origin.
    const o = xyForFaceTexel(face, 0, 0, n);
    const [tx, ty] = expectTile[face];
    assert.equal(o.x, tx * n, `face ${face} tileX origin`);
    assert.equal(o.y, ty * n, `face ${face} tileY origin`);
    // last cell (n-1,n-1) sits at the far corner of that tile.
    const c = xyForFaceTexel(face, n - 1, n - 1, n);
    assert.equal(c.x, tx * n + (n - 1), `face ${face} far x`);
    assert.equal(c.y, ty * n + (n - 1), `face ${face} far y`);
  }
}

// --- known atlas index → expected (x,y) ----------------------------------
// Mirrors the Rust loop `atlas[y*(3n)+x] = field.h[idx(face,i,j)]`,
// idx = face·n² + j·n + i. Verify a representative cell on face 4
// (tile (1,1)) round-trips through both the cell→xy and the flat
// index→xy helpers consistently.
{
  const n = 16;
  const w = ATLAS_COLS * n; // 48
  const face = 4;
  const i = 5;
  const j = 9;
  const { x, y } = xyForFaceTexel(face, i, j, n);
  // tileX = 4%3 = 1, tileY = floor(4/3) = 1.
  assert.equal(x, 1 * n + i, "face4 x");
  assert.equal(y, 1 * n + j, "face4 y");

  const flat = y * w + x; // Rust H0Atlas.atlas element index.
  const back = atlasIndexToXY(flat, n);
  assert.equal(back.x, x, "index→x roundtrip");
  assert.equal(back.y, y, "index→y roundtrip");

  // Spot a couple more faces explicitly.
  assert.deepEqual(xyForFaceTexel(0, 0, 0, n), { x: 0, y: 0 });
  assert.deepEqual(xyForFaceTexel(5, n - 1, n - 1, n), {
    x: 2 * n + (n - 1),
    y: 1 * n + (n - 1),
  });
}

// --- uploadH0: texture image dims = 3·faceRes × 2·faceRes ----------------
{
  const faceRes = 8;
  const len = ATLAS_COLS * ATLAS_ROWS * faceRes * faceRes; // 6·n·n
  const atlas = new Float32Array(len);
  // Put a sentinel at cube cell (face=3,i=2,j=3): flat = y·(3n)+x.
  const { x, y } = xyForFaceTexel(3, 2, 3, faceRes);
  const k = y * (ATLAS_COLS * faceRes) + x;
  atlas[k] = 0.4242;

  const tex = uploadH0(atlas, faceRes);
  assert.equal(tex.image.width, 3 * faceRes, "tex width = 3·faceRes");
  assert.equal(tex.image.height, 2 * faceRes, "tex height = 2·faceRes");
  assert.equal(tex.flipY, false, "flipY must be false (row0 = UV v=0)");
  // `needsUpdate` is a write-only setter (bumps `.version`); observe it.
  assert.ok(tex.version > 0, "needsUpdate bumped texture version");
  // RGBA32F: the sentinel height lands in the R channel of texel k.
  const data = tex.image.data as unknown as Float32Array;
  assert.equal(data.length, 3 * faceRes * 2 * faceRes * 4, "RGBA length");
  assert.ok(
    Math.abs(data[k * 4] - 0.4242) < 1e-6,
    "h → R channel at the right texel",
  );
  assert.equal(data[k * 4 + 1], 0, "G = 0");
  assert.equal(data[k * 4 + 2], 0, "B = 0");
  assert.equal(data[k * 4 + 3], 0, "A = 0");
}

// --- uploadH0: rejects a wrongly-sized atlas -----------------------------
{
  assert.throws(
    () => uploadH0(new Float32Array(10), 8),
    /atlas length 10 != 6/,
    "must reject mismatched atlas length",
  );
}

console.log("ok");
