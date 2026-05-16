// Task A16: upload the Rust-rasterised cube-sphere `h0` atlas to a
// `THREE.DataTexture` for `runErodeBake`'s `srcH0Tex`.
//
// TRI-SOURCE ATLAS-LAYOUT LOCKSTEP — all three legs must stay
// bit-identical or A18 CPU↔GPU h0 parity silently breaks:
//   1. Producer:  wizard.rs::bake_h0_v2_impl  (Rust serialisation)
//   2. Uploader:  this file — xyForFaceTexel / uploadH0  (← you are here)
//   3. Consumer:  erodePipeline.ts RESTRICT_FRAG + H0_RESAMPLE_FRAG,
//                 each with a local `srcFaceUvToAtlas`
//
// Canonical layout spec lives in passes.glsl.ts GLSL_ATLAS helpers
// (`faceCellToAtlasUv` / `faceUvToAtlasUv`). Quoting the formula
// (NORMATIVE — this file MUST mirror it or A15/A18 silently read
// garbage h0):
//
//   tileX = face % 3 ; tileY = face / 3   (face 0..5)
//   atlas uv = ( (tileX + faceU) / 3 , (tileY + faceV) / 2 )
//   faceU = (i + 0.5) / n   faceV = (j + 0.5) / n
//
// So face → tile: 0→(0,0) 1→(1,0) 2→(2,0) 3→(0,1) 4→(1,1) 5→(2,1).
// Cube cell (face,i,j) lands at atlas pixel x = tileX·n + i,
// y = tileY·n + j. The Rust `atlas` Vec<f32> is exactly
// `atlas[y·(3n) + x]` (length 6·n·n; the 1-channel height field).
//
// `runErodeBake` consumes `srcH0Tex` via `RESTRICT_FRAG` /
// `H0_RESAMPLE_FRAG` (erodePipeline.ts), which sample
// `texture(uSrc, srcFaceUvToAtlas(...))` — `srcFaceUvToAtlas` is the
// identical `(tileX+fu)/3, (tileY+fv)/2` formula. `RESTRICT_FRAG` copies
// the FULL RGBA (`fragColor = texture(uSrc, ...)`; r=h, g=water, b=sed,
// a=ocean), so the texture MUST be RGBAFormat. The Rust atlas only carries
// height (the macro `h0` reference / start field — `RESTRICT_FRAG`
// consumes `.r`); we expand it into RGBA placing h in R and 0 in G/B/A
// (water=0, sed=0, ocean=false — the rasterised macro field has no
// transported water/sediment yet, and ocean is re-derived downstream
// from h).
//
// `THREE.DataTexture` and the bake render targets both default to
// `flipY = false`, so DataTexture element (y·3n + x) is sampled at UV
// ((x+0.5)/3n, (y+0.5)/2n) — bit-for-bit the GLSL sample point. Nearest
// filtering + clamp-to-edge match the pipeline's nearest/manual-bilinear
// contract (no hardware bilinear assumed across the tile seams).

import * as THREE from "three";

/** Atlas tiling constants — MUST equal GLSL_PREAMBLE ATLAS_COLS/ATLAS_ROWS. */
export const ATLAS_COLS = 3;
export const ATLAS_ROWS = 2;

/** Atlas texture dimensions for a given per-face resolution `n`. */
export function atlasDims(faceRes: number): { width: number; height: number } {
  return { width: ATLAS_COLS * faceRes, height: ATLAS_ROWS * faceRes };
}

/**
 * Pure (GL-free) layout math: cube cell `(face,i,j)` → atlas pixel
 * `(x,y)` in the 3×2 tiling. Inverse of the Rust serialisation loop and
 * of the GLSL `srcFaceUvToAtlas` cell address. `face` in 0..5.
 */
export function xyForFaceTexel(
  face: number,
  i: number,
  j: number,
  faceRes: number,
): { x: number; y: number } {
  const tileX = face % ATLAS_COLS; // face % 3
  const tileY = Math.floor(face / ATLAS_COLS); // face / 3
  return { x: tileX * faceRes + i, y: tileY * faceRes + j };
}

/**
 * Pure inverse: a flat row-major atlas index (the Rust `H0Atlas.atlas`
 * element index, `y·(3·faceRes) + x`) → its `(x,y)` pixel.
 */
export function atlasIndexToXY(
  index: number,
  faceRes: number,
): { x: number; y: number } {
  const w = ATLAS_COLS * faceRes;
  return { x: index % w, y: Math.floor(index / w) };
}

/**
 * Build the `srcH0Tex` `THREE.DataTexture` from the Rust `H0Atlas.atlas`
 * (length `6·faceRes·faceRes`, row-major height field). RGBA32F so
 * `RESTRICT_FRAG`'s full-RGBA fetch is well-defined; h → R, G/B/A = 0.
 */
export function uploadH0(
  atlas: number[] | Float32Array,
  faceRes: number,
): THREE.DataTexture {
  const { width, height } = atlasDims(faceRes);
  const expected = ATLAS_COLS * ATLAS_ROWS * faceRes * faceRes; // 6·n·n
  if (atlas.length !== expected) {
    throw new Error(
      `uploadH0: atlas length ${atlas.length} != 6·faceRes² (${expected}) ` +
        `for faceRes ${faceRes}`,
    );
  }

  // Expand the 1-channel height atlas into RGBA32F (h, 0, 0, 0). The
  // flat ordering is preserved 1:1 (element k → RGBA texel k), so the
  // DataTexture's texel (x,y) = atlas[y·width + x], matching the GLSL
  // `srcFaceUvToAtlas` sample (flipY=false on both sides).
  const data = new Float32Array(width * height * 4);
  for (let k = 0; k < atlas.length; k++) {
    data[k * 4] = atlas[k]; // R = h
    // G/B/A left 0 (water=0, sed=0, ocean=false): re-derived downstream.
  }

  const tex = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false; // matches Rust row-0 = atlas-UV v=0 + RT default.
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
