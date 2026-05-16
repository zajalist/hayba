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
// EQUIRECT-UV CONVENTION — must match exactly how `RESAMPLE_FRAG`
// (passes.glsl.ts, port of `cubesphere_to_equirect`) WROTE the equirect:
//
//   RESAMPLE_FRAG forward map (equirect texel -> sphere):
//     yRow = hgt - gl_FragCoord.y   (yRow=0 at TOP; gl_FragCoord.y=hgt is the top row)
//     v    = yRow / hgt             (v=0 -> top row, v=1 -> bottom row)
//     phi  = PI/2 - v*PI            (lat: +PI/2 at v=0/top = NORTH, -PI/2 at v=1/bottom = SOUTH)
//     u    = px / w
//     lam  = u*2PI - PI                  (lon: -PI at u=0, +PI at u=1)
//     pos  = (cos phi*cos lam, sin phi, cos phi*sin lam)   [Y-up]
//
//   So RESAMPLE_FRAG writes NORTH pole -> top framebuffer row, SOUTH -> bottom row.
//   WebGLRenderTarget.texture has no Y-flip, so to sample sphere normal n:
//
//   Inverse here (sphere unit normal -> equirect uv we SAMPLE):
//     phi  = asin(n.y)
//     lam  = atan2(n.z, n.x)
//     uTex = lam/(2PI) + 0.5             (= atan2(z,x)/(2PI)+0.5)
//     vTex = 0.5 + asin(n.y)/PI          (n.y=+1 north -> vTex=1 = top row
//                                          where RESAMPLE_FRAG wrote north;
//                                          n.y=-1 south -> vTex=0 = bottom)
//
// GLSL FOOTGUN: no backticks anywhere in the shader strings (this file
// follows the `.glsl.ts` array-join convention so the template-literal
// trap can never bite).

import * as THREE from "three";

const VERT: string = [
  "varying vec3 vSpherePos;",
  "void main(){",
  "  /* Object-space position of a unit-ish SphereGeometry vertex; the",
  "     equirect uv is derived per-fragment from its normalized form so",
  "     the mapping is independent of the sphere radius. */",
  "  vSpherePos = position;",
  "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
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
  "",
  "const float PI = 3.141592653589793;",
  "",
  "/* sphere unit normal -> equirect uv, inverse of RESAMPLE_FRAG. */",
  "vec2 sphereToEquirectUv(vec3 n){",
  "  float lam = atan(n.z, n.x);          /* atan2(z, x) in [-PI, PI]      */",
  "  float u = lam / (2.0 * PI) + 0.5;    /* [0,1], lon wrap exact         */",
  "  float v = 0.5 + asin(clamp(n.y, -1.0, 1.0)) / PI; /* n.y=+1 north -> v=1 (top row; RESAMPLE_FRAG wrote north to the top, south to the bottom row) */",
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
  "  /* Pick the eroded vs raw view. Sample both with explicit-LOD-free",
  "     texture2D() (RGBA32F, NearestFilter targets) — the relief shading",
  "     uses screen-space derivatives of the SAMPLED height, which works",
  "     regardless of the texture filter. */",
  "  float hEroded = texture2D(uHeight,  uv).r;",
  "  float hRaw    = texture2D(uHeight0, uv).r;",
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
  "     where the hillshade is ambiguous (gradient magnitude term). */",
  "  float steep = clamp(length(vec2(dhx, dhy)) * 220.0, 0.0, 1.0);",
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
  mat.uniformsNeedUpdate = true;
}

/** 0 = show `h_final` (eroded); non-zero = show `h0` (no-erosion). */
export function setDebugMapMode(mat: THREE.ShaderMaterial, n: number): void {
  mat.uniforms.uMapMode.value = n;
  mat.uniformsNeedUpdate = true;
}
