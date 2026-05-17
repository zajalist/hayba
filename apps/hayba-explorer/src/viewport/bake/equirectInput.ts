import * as THREE from "three";

/** Upload a length-(w*h) Float32Array as a single-channel (.r) RGBA32F
 *  DataTexture. Row 0 = North pole (no flipY). Nearest/clamp — the
 *  hydraulic shaders sample by explicit texel math. */
export function uploadEquirect(src: Float32Array, w: number, h: number): THREE.DataTexture {
  if (src.length !== w * h) throw new Error(`uploadEquirect: expected ${w*h}, got ${src.length}`);
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data[i * 4] = src[i];
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
