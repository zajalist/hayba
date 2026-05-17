// Task A17: equirect relief debug material.
//
// A `THREE.ShaderMaterial` for a `THREE.SphereGeometry` planet that
// samples the `runErodeBake` equirect output (`h_final`, height in `.r`)
// and renders it as hypsometric shaded relief so the eroded
// valleys/ridges read by eye. It exists purely so A18/A19 can eyeball
// the GPU bake (erosion vs no-erosion) on a real globe — it is a debug
// / validation surface, NOT the production renderer (that is Subsystem
// D).
//
// EQUIRECT-UV CONVENTION — matches the 2026-05-16 HYDRAULIC REWORK
// equirect convention (the old cube-sphere RESAMPLE_FRAG was deleted):
//
//   Rust `bake_inputs_equirect` (bake_equirect.rs) writes data so that
//   row ry=0 = NORTH pole: lat = 90 - (ry+0.5)/H*180,
//   lon = (rx+0.5)/W*360 - 180. `uploadEquirect` uses flipY=false and the
//   hydraulic shaders (+ the eroded WebGLRenderTarget) apply NO Y-flip, so
//   data row 0 (NORTH) == texture/framebuffer row 0 == texture v ~= 0;
//   SOUTH == row H-1 == v ~= 1. Longitude: lon = u*360 - 180.
//
//   Inverse here (sphere unit normal n -> equirect uv we SAMPLE):
//     lam  = atan2(n.z, n.x)
//     uTex = lam/(2PI) + 0.5             (= atan2(z,x)/(2PI)+0.5)
//     vTex = 0.5 - asin(n.y)/PI          (n.y=+1 NORTH -> vTex=0 = row 0,
//                                          where the rework writes north;
//                                          n.y=-1 SOUTH -> vTex=1 = row H-1)
//
// GLSL FOOTGUN: no backticks anywhere in the shader strings (this file
// follows the `.glsl.ts` array-join convention so the template-literal
// trap can never bite).

import * as THREE from "three";

// The vertex shader EXTRUDES the smooth SphereGeometry by the BAKED
// equirect height (sampled in-vertex), so erosion reads as real geometry
// (land bulges out, ocean basins sink in) and the no-erosion toggle is a
// true 3D before/after — not a faint hillshade on a featureless ball.
// `sphereToEquirectUv` is duplicated from FRAG and MUST stay byte-identical
// to it (same orientation: v = 0.5 - asin(n.y)/PI) or the displacement and
// the shaded relief desync. WebGL2 (three r169) guarantees vertex texture
// fetch, so texture2D() in the vertex stage is safe.
const VERT: string = [
  "precision highp float;",
  "varying vec3 vSpherePos;",
  "uniform sampler2D uHeight;",
  "uniform sampler2D uHeight0;",
  "uniform float uMapMode;",
  "uniform float uDisplace;",
  "const float PI = 3.141592653589793;",
  "vec2 sphereToEquirectUv(vec3 n){",
  "  float lam = atan(n.z, n.x);",
  "  float u = lam / (2.0 * PI) + 0.5;",
  "  float v = 0.5 - asin(clamp(n.y, -1.0, 1.0)) / PI;",
  "  return vec2(u, v);",
  "}",
  "void main(){",
  "  /* vSpherePos stays the UNDISPLACED unit position so the FRAG equirect",
  "     uv + hillshade are unaffected; gl_Position is the extruded vertex. */",
  "  vSpherePos = position;",
  "  vec3 nrm = normalize(position);",
  "  vec2 uv = sphereToEquirectUv(nrm);",
  "  float hE = texture2D(uHeight,  uv).r;",
  "  float hR = texture2D(uHeight0, uv).r;",
  "  float hh = mix(hE, hR, step(0.5, uMapMode));",
  "  vec3 dispPos = position + nrm * (hh * uDisplace);",
  "  gl_Position = projectionMatrix * modelViewMatrix * vec4(dispPos, 1.0);",
  "}",
].join("\n");

const FRAG: string = [
  "precision highp float;",
  "varying vec3 vSpherePos;",
  "",
  "uniform sampler2D uHeight;   /* h_final equirect (eroded), height in .r */",
  "uniform sampler2D uHeight0;  /* h0 equirect (no-erosion), height in .r  */",
  "uniform float uMapMode;      /* 0 = h_final (eroded), 1 = h0 (raw)      */",
  "uniform float uReliefStrength; /* hillshade contribution gain           */",
  "uniform vec3  uSunDir;       /* light direction for the slope hillshade */",
  "uniform vec2  uTexSize;      /* equirect texel size = (1/W, 1/H)        */",
  "",
  "const float PI = 3.141592653589793;",
  "",
  "/* Manual 4-tap bilinear of the equirect height texture. The eroded RT",
  "   and the base DataTexture are RGBA32F with NearestFilter (and",
  "   OES_texture_float_linear is not guaranteed), so hardware linear",
  "   filtering can't be relied on — a single texture2D() tap makes the",
  "   smooth debug sphere show hard texel stair-steps. This reconstructs",
  "   bilinear in-shader from uTexSize so the relief reads smoothly",
  "   regardless of the sampler's filter mode. */",
  "vec4 biTap(sampler2D t, vec2 uv){",
  "  vec2 res = 1.0 / uTexSize;            /* texel grid resolution (W,H)   */",
  "  vec2 p = uv * res - 0.5;              /* sample pos in texel space     */",
  "  vec2 f = fract(p);",
  "  vec2 base = (floor(p) + 0.5) * uTexSize;",
  "  vec4 s00 = texture2D(t, base);",
  "  vec4 s10 = texture2D(t, base + vec2(uTexSize.x, 0.0));",
  "  vec4 s01 = texture2D(t, base + vec2(0.0, uTexSize.y));",
  "  vec4 s11 = texture2D(t, base + uTexSize);",
  "  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);",
  "}",
  "",
  "/* sphere unit normal -> equirect uv (hydraulic-rework convention). */",
  "vec2 sphereToEquirectUv(vec3 n){",
  "  float lam = atan(n.z, n.x);          /* atan2(z, x) in [-PI, PI]      */",
  "  float u = lam / (2.0 * PI) + 0.5;    /* [0,1], lon wrap exact         */",
  "  float v = 0.5 - asin(clamp(n.y, -1.0, 1.0)) / PI; /* n.y=+1 north -> v=0 (row 0, where the rework writes north; flipY=false, no shader Y-flip) */",
  "  return vec2(u, v);",
  "}",
  "",
  "/* Hypsometric ramp: ocean (h<0) blue ramp, land (h>=0) green->brown->",
  "   white. Heights are the normalized [-1,1] elevation the pipeline",
  "   carries; the band edges are chosen so a typical eroded planet reads",
  "   with recognizable shelf / lowland / upland / peak structure. */",
  "vec3 hypsometric(float h){",
  "  if (h < 0.0){",
  "    /* Deep abyss -> shelf. Darkest at the bottom, lighter toward 0. */",
  "    float t = clamp(1.0 + h, 0.0, 1.0); /* h=-1 -> 0, h=0 -> 1 */",
  "    vec3 deep    = vec3(0.015, 0.05, 0.18);",
  "    vec3 mid     = vec3(0.05,  0.20, 0.42);",
  "    vec3 shelf   = vec3(0.16,  0.42, 0.62);",
  "    if (t < 0.6) return mix(deep, mid, t / 0.6);",
  "    return mix(mid, shelf, (t - 0.6) / 0.4);",
  "  }",
  "  /* Land: coastal green -> savanna -> brown highland -> rock -> snow. */",
  "  float t = clamp(h, 0.0, 1.0);",
  "  vec3 lowland  = vec3(0.24, 0.46, 0.20);",
  "  vec3 plain    = vec3(0.47, 0.55, 0.26);",
  "  vec3 foothill = vec3(0.55, 0.45, 0.27);",
  "  vec3 upland   = vec3(0.45, 0.34, 0.24);",
  "  vec3 rock     = vec3(0.55, 0.52, 0.50);",
  "  vec3 snow     = vec3(0.96, 0.97, 0.99);",
  "  if (t < 0.10) return mix(lowland,  plain,    t / 0.10);",
  "  if (t < 0.30) return mix(plain,    foothill, (t - 0.10) / 0.20);",
  "  if (t < 0.55) return mix(foothill, upland,   (t - 0.30) / 0.25);",
  "  if (t < 0.78) return mix(upland,   rock,     (t - 0.55) / 0.23);",
  "  return mix(rock, snow, (t - 0.78) / 0.22);",
  "}",
  "",
  "void main(){",
  "  vec3 n = normalize(vSpherePos);",
  "  vec2 uv = sphereToEquirectUv(n);",
  "",
  "  /* Pick the eroded vs raw view. biTap() does manual 4-tap bilinear",
  "     (RGBA32F NearestFilter targets — hardware linear isn't guaranteed)",
  "     so the smooth sphere doesn't show texel stair-steps; the relief",
  "     hillshade then uses screen-space derivatives of this filtered",
  "     height. */",
  "  float hEroded = biTap(uHeight,  uv).r;",
  "  float hRaw    = biTap(uHeight0, uv).r;",
  "  float h = mix(hEroded, hRaw, step(0.5, uMapMode));",
  "",
  "  vec3 base = hypsometric(h);",
  "",
  "  /* Slope / hillshade from screen-space derivatives of the sampled",
  "     height. dFdx/dFdy is always available in WebGL2 (Three r169 = GL2)",
  "     so no #extension is needed. Reconstruct a tangent-space-ish normal",
  "     from the height gradient and dot it with the sun direction; this",
  "     makes the eroded dendritic valleys/ridges legible as shading even",
  "     though the sphere itself is smooth. */",
  "  float dhx = dFdx(h);",
  "  float dhy = dFdy(h);",
  "  /* Scale the gradient so erosion-scale relief produces visible shading",
  "     without blowing out; the constant is a debug-tuned exaggeration. */",
  "  vec3 sn = normalize(vec3(-dhx, -dhy, 1.0 / 64.0));",
  "  float lambert = clamp(dot(sn, normalize(uSunDir)), 0.0, 1.0);",
  "  float shade = mix(1.0, 0.35 + 0.65 * lambert, clamp(uReliefStrength, 0.0, 1.0));",
  "",
  "  /* Slope-keyed darkening so steep eroded faces read as relief even",
  "     where the hillshade is ambiguous. 30.0 saturates at |grad|~0.033",
  "     (the incised-channel scale); higher constants crush all eroded",
  "     terrain to a flat dark band and hide the dendritic detail. */",
  "  float steep = clamp(length(vec2(dhx, dhy)) * 30.0, 0.0, 1.0);",
  "  vec3 col = base * shade;",
  "  col = mix(col, col * 0.62, steep * 0.5);",
  "",
  "  /* Subtle ocean specular-ish lift so water/land separation is crisp. */",
  "  if (h < 0.0) col += vec3(0.02, 0.03, 0.05) * (1.0 + h);",
  "",
  "  gl_FragColor = vec4(col, 1.0);",
  "}",
].join("\n");

/**
 * Build the equirect relief debug material. Bind textures with
 * {@link setDebugTexture} and flip the eroded/raw view with
 * {@link setDebugMapMode}.
 *
 * Uniforms:
 *  - `uHeight`  — the `h_final` equirect (eroded) texture, height in `.r`.
 *  - `uHeight0` — the `h0` / no-erosion equirect texture (A19 toggle).
 *  - `uMapMode` — 0 shows `uHeight` (eroded), 1 shows `uHeight0` (raw).
 *  - `uReliefStrength` — hillshade gain (0 = flat hypsometric, 1 = full).
 *  - `uSunDir`  — light direction for the screen-space slope hillshade.
 *  - `uDisplace` — vertex-extrusion gain: each vertex is pushed along its
 *    normal by `bakedHeight * uDisplace` so erosion is real geometry.
 *    Default 0.12 on a unit-radius sphere ([-1,1] height → ±0.12 relief:
 *    land bulges, ocean sinks). Tune with {@link setDebugDisplace}.
 */
export function makeDebugReliefMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uHeight: { value: null as THREE.Texture | null },
      uHeight0: { value: null as THREE.Texture | null },
      uMapMode: { value: 0 },
      uReliefStrength: { value: 1.0 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.4).normalize() },
      // Equirect texel size (1/W, 1/H) for the in-shader bilinear. The
      // 1,1 default is overwritten by setDebugTexture (derived from the
      // bound texture's image / RT size) — a degenerate but safe value
      // until a real texture is bound.
      uTexSize: { value: new THREE.Vector2(1, 1) },
      // Vertex-extrusion gain (see header). 0.12 = strong, clearly-3D
      // relief on a unit sphere; the no-erosion toggle then visibly
      // changes the SHAPE, not just the shading.
      uDisplace: { value: 0.12 },
    },
    // dFdx/dFdy are core in WebGL2 (Three r169) — no extension flag needed.
  });
}

/**
 * Bind the bake outputs. `hFinalTex` is the eroded equirect (`uHeight`);
 * `h0Tex` is the optional no-erosion equirect for the A19 toggle. When
 * `h0Tex` is omitted both slots fall back to `hFinalTex` so flipping the
 * map mode never renders a black globe.
 */
export function setDebugTexture(
  mat: THREE.ShaderMaterial,
  hFinalTex: THREE.Texture,
  h0Tex?: THREE.Texture | null,
): void {
  mat.uniforms.uHeight.value = hFinalTex;
  mat.uniforms.uHeight0.value = h0Tex ?? hFinalTex;
  // Derive the equirect texel size (1/W, 1/H) for the in-shader bilinear
  // straight from the bound eroded texture. A RenderTarget texture and a
  // DataTexture both expose dimensions via `.image` ({width,height}); the
  // eroded RT and the base DataTexture are the same W×H equirect grid.
  const img = hFinalTex.image as
    | { width?: number; height?: number }
    | undefined;
  const w = img?.width && img.width > 0 ? img.width : 1;
  const h = img?.height && img.height > 0 ? img.height : 1;
  (mat.uniforms.uTexSize.value as THREE.Vector2).set(1 / w, 1 / h);
  mat.uniformsNeedUpdate = true;
}

/** 0 = show `h_final` (eroded); non-zero = show `h0` (no-erosion). */
export function setDebugMapMode(mat: THREE.ShaderMaterial, n: number): void {
  mat.uniforms.uMapMode.value = n;
  mat.uniformsNeedUpdate = true;
}

/** Vertex-extrusion gain (height -> radial displacement). Default 0.12. */
export function setDebugDisplace(mat: THREE.ShaderMaterial, n: number): void {
  mat.uniforms.uDisplace.value = n;
  mat.uniformsNeedUpdate = true;
}
