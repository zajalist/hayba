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

// A 1x1 opaque-black RGBA32F texture so `uStackTex` is never null before a
// stack RT is bound (a null sampler binds three's default white texture and
// warns). Module-shared + immutable — every material reuses this one.
const STACK_PLACEHOLDER_TEX: THREE.DataTexture = (() => {
  const t = new THREE.DataTexture(
    new Float32Array([0, 0, 0, 1]),
    1,
    1,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  t.needsUpdate = true;
  return t;
})();

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
  "uniform float uStackMode;",
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
  "  /* Only FLAT (uStackMode 2) renders UNdisplaced; relief(0)/draped(1)/",
  "     normal(3) all extrude as before. */",
  "  float dispGain = (uStackMode > 1.5 && uStackMode < 2.5) ? 0.0 : 1.0;",
  "  vec3 dispPos = position + nrm * (hh * uDisplace * dispGain);",
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
  "uniform sampler2D uStackTex; /* selected stack RT (clim|terr|hydro)      */",
  "uniform float uChannel;      /* which RGBA lane of uStackTex (0..3)      */",
  "uniform float uStackMode;    /* 0 relief 1 draped 2 flat 3 normal-map  */",
  "uniform float uWindTime;",
  "uniform float uRamp;         /* 0 grey 1 temp 2 precip 3 hue 4 grey-elev 5 continentality 6 pressure 7 KG-discrete */",
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
  "/* HSV hue wheel (saturated, full value) from a turn fraction in [0,1). */",
  "vec3 hsv2rgb(float hh){",
  "  vec3 c = abs(mod(hh * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0;",
  "  return clamp(c, 0.0, 1.0);",
  "}",
  "",
  "/* Map a raw stack-channel value to a debug colour. ids:",
  "   0 grey (raw clamp 0..1) · 1 temp diverging (deg C, -30..+35) ·",
  "   2 precip white->blue (0..1) · 3 hue (turns, for wind/aspect) ·",
  "   4 grey-elev (0..1) · 5 continentality-index (Conrad-style green→yellow→red) ·",
  "   6 pressure diverging (low=blue, mid=cream, high=red) ·",
  "   7 Köppen-Geiger discrete (15-class id 0..14 → categorical colour). Calibration of",
  "   climate units is downstream tuning; this is a deterministic debug",
  "   visualiser. */",
  "vec3 ramp(float id, float x){",
  "  if (id < 0.5) return vec3(clamp(x, 0.0, 1.0));",
  "  if (id < 1.5){",
  "    float t = clamp((x + 30.0) / 65.0, 0.0, 1.0);",
  "    vec3 cold = vec3(0.13, 0.30, 0.75);",
  "    vec3 midw = vec3(0.96, 0.96, 0.92);",
  "    vec3 hot  = vec3(0.78, 0.16, 0.13);",
  "    return (t < 0.5) ? mix(cold, midw, t / 0.5) : mix(midw, hot, (t - 0.5) / 0.5);",
  "  }",
  "  if (id < 2.5) return mix(vec3(0.97), vec3(0.10, 0.35, 0.70), clamp(x, 0.0, 1.0));",
  "  if (id < 3.5) return hsv2rgb(fract(x));",
  "  if (id < 4.5) return vec3(clamp(x, 0.0, 1.0));",
  // T3-RAMPS id=5: continentality-index palette (Conrad/Gorczyński-style).
  // Sequential GREEN → YELLOW → RED, matching the standard meteorological
  // continentality-index atlas (NOT Köppen-D climate zones — those are
  // categorical, blue-leaning, and indicate COLD continental specifically;
  // continentality index is a scalar annual-T-amplitude proxy that runs
  // hot in the Sahara/Australia interior just as it runs cold in
  // Mongolia/Siberia interior).
  //   0.00 cool green-blue (oceanic, mild)
  //   0.25 yellow-green (slightly continental)
  //   0.50 yellow (transitional)
  //   0.75 orange (continental)
  //   1.00 dark red-brown (extreme continental amplitude)
  "  if (id < 5.5){",
  "    float t = clamp(x, 0.0, 1.0);",
  "    vec3 c0 = vec3(0.20, 0.55, 0.45);",
  "    vec3 c1 = vec3(0.65, 0.80, 0.30);",
  "    vec3 c2 = vec3(0.98, 0.88, 0.20);",
  "    vec3 c3 = vec3(0.90, 0.45, 0.10);",
  "    vec3 c4 = vec3(0.55, 0.10, 0.05);",
  "    if (t < 0.25) return mix(c0, c1, t / 0.25);",
  "    if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);",
  "    if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);",
  "    return mix(c3, c4, (t - 0.75) / 0.25);",
  "  }",
  // T3-RAMPS id=6: pressure diverging (meteorological convention).
  //   0.00 low pressure → deep blue
  //   0.50 mid pressure → pale cream
  //   1.00 high pressure → deep red
  // Output is already normalised in PRESSURE_VIZ_FRAG to 0..1 covering
  // mb [985..1030]. Anchored at 0.5 so the cream band lines up with the
  // ~1013 mb global mean.
  "  if (id < 6.5){",
  "    float t = clamp(x, 0.0, 1.0);",
  "    vec3 lowP  = vec3(0.13, 0.27, 0.65);",
  "    vec3 midP  = vec3(0.97, 0.96, 0.88);",
  "    vec3 highP = vec3(0.78, 0.13, 0.13);",
  "    return (t < 0.5) ? mix(lowP, midP, t / 0.5) : mix(midP, highP, (t - 0.5) / 0.5);",
  "  }",
  // T4 id=7: Köppen-Geiger discrete palette (15 classes). x = raw class
  // id (0..14) emitted by CLIMATE_CLASS_FRAG. Colours roughly mirror
  // the Beck et al. 2023 KG colour key (blue tropics, red deserts,
  // green humid temperate, teal humid continental, grey/white polar).
  "  if (id < 7.5){",
  "    float c = floor(clamp(x, 0.0, 14.0) + 0.5);",
  "    if (c < 0.5) return vec3(0.05, 0.10, 0.20);",  // 0 Ocean (dark — usually not drawn)
  // Beck et al. 2023 Köppen palette: Af deep blue, Am medium blue,
  // Aw is YELLOW-cream (savanna), not light blue. Light blue for Aw
  // made the three A-classes visually indistinguishable.
  "    if (c < 1.5) return vec3(0.00, 0.00, 0.85);",  // 1 Af deep blue
  "    if (c < 2.5) return vec3(0.00, 0.55, 0.95);",  // 2 Am medium blue
  "    if (c < 3.5) return vec3(0.98, 0.85, 0.40);",  // 3 Aw yellow-cream
  "    if (c < 4.5) return vec3(0.95, 0.10, 0.10);",  // 4 BWh red
  "    if (c < 5.5) return vec3(0.95, 0.55, 0.55);",  // 5 BWk pink
  "    if (c < 6.5) return vec3(0.96, 0.60, 0.15);",  // 6 BSh orange
  "    if (c < 7.5) return vec3(1.00, 0.85, 0.30);",  // 7 BSk yellow
  "    if (c < 8.5) return vec3(0.70, 0.65, 0.05);",  // 8 Csa olive
  "    if (c < 9.5) return vec3(0.75, 1.00, 0.30);",  // 9 Cfa lime
  "    if (c < 10.5) return vec3(0.35, 0.85, 0.30);", // 10 Cfb green
  "    if (c < 11.5) return vec3(0.20, 0.85, 0.85);", // 11 Dfa/b cyan
  "    if (c < 12.5) return vec3(0.05, 0.55, 0.55);", // 12 Dfc teal
  "    if (c < 13.5) return vec3(0.70, 0.70, 0.70);", // 13 ET grey
  "    return vec3(0.98, 0.98, 0.98);",               // 14 EF icecap
  "  }",
  // RIVERS/LAKES id=8: tan below threshold, bright cyan→deep blue above.
  // Reads Q discharge (.r) for Rivers OR endorheic flag (.b) for Lakes.
  // Both are 0..1-ish intensity fields so the same ramp serves both.
  "  if (id < 8.5){",
  // Rivers/Lakes — log-compress the discharge / endo field then apply a
  // sharp 0.65 step so MOST of land stays tan and only true river
  // trunks / lake basins show blue. Without the log compression every
  // cell with any drainage lit up blue (Q has huge dynamic range).
  // NOTE: `tan` is a GLSL builtin (tangent); local must NOT shadow it
  // or some drivers fail-to-link the whole material → relief breaks.
  "    float t = clamp(x, 0.0, 1.0);",
  "    float tLog = log(1.0 + 100.0 * t) / log(101.0);",
  "    vec3 tanCol = vec3(0.85, 0.78, 0.55);",
  "    vec3 cyan   = vec3(0.35, 0.78, 0.95);",
  "    vec3 deep   = vec3(0.05, 0.20, 0.55);",
  "    if (tLog < 0.65) return tanCol;",
  "    return mix(cyan, deep, (tLog - 0.65) / 0.35);",
  "  }",
  "  return vec3(clamp(x, 0.0, 1.0));",
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
  "  /* RELIEF (uStackMode 0): byte-identical to the original — `col` above",
  "     is unchanged; only the write is now gated so non-relief modes can't",
  "     reach it. */",
  "  if (uStackMode < 0.5){",
  "    gl_FragColor = vec4(col, 1.0);",
  "    return;",
  "  }",
  "",
  "  /* WIND (uStackMode 4 draped / 5 flat, NX-3): stateless animated",
  "     flow streaks from CLIM.b azimuth advanced by uWindTime. Taken",
  "     before the normal(>2.5) branch so relief(0)/draped(1)/flat(2)/",
  "     normal(3) are byte-unchanged (4/5 return here first). No RT/",
  "     ping-pong — display-only, zero feedback-loop surface. */",
  "  if (uStackMode > 3.5){",
  "    vec3 w = texture2D(uStackTex, uv).rgb;",
  "    float wi = max(max(w.r, w.g), w.b);",
  "    if (uStackMode > 4.5){",
  "      gl_FragColor = vec4(w, 1.0);",
  "    } else {",
  "      vec3 dcol = col + w * 1.4;",
  "      dcol = mix(dcol, dcol * 0.75, steep * 0.4);",
  "      gl_FragColor = vec4(dcol, 1.0);",
  "    }",
  "    return;",
  "  }",
  "",
  "  /* NORMAL (uStackMode 3, SP-B): classic RGB normal map of the eroded",
  "     heightfield. `sn` is the screen-space height-gradient normal already",
  "     built above for the hillshade; encode it [-1,1]->[0,1]. Additive —",
  "     taken before the stack-channel branch so relief(<0.5)/draped(1)/",
  "     flat(2) are byte-unchanged. */",
  "  if (uStackMode > 2.5){",
  "    gl_FragColor = vec4(sn * 0.5 + 0.5, 1.0);",
  "    return;",
  "  }",
  "",
  "  /* STACK (draped 1 / flat 2): pick the selected RGBA lane, ramp it. */",
  "  vec4 sTex = texture2D(uStackTex, uv);",
  "  float chv = sTex.r;",
  "  if (uChannel > 2.5) chv = sTex.a;",
  "  else if (uChannel > 1.5) chv = sTex.b;",
  "  else if (uChannel > 0.5) chv = sTex.g;",
  "  vec3 rc = ramp(uRamp, chv);",
  "  if (uStackMode > 1.5){",
  "    gl_FragColor = vec4(rc, 1.0);            /* flat: pure ramp        */",
  "  } else {",
  "    vec3 dcol = rc * shade;                  /* draped: ramp x relief  */",
  "    dcol = mix(dcol, dcol * 0.62, steep * 0.5);",
  "    gl_FragColor = vec4(dcol, 1.0);",
  "  }",
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
 *    Default 0.05 on a unit-radius sphere ([-1,1] height → ±0.05 relief:
 *    land bulges, ocean sinks) — readable 3D without over-dramatising.
 *    Tune with {@link setDebugDisplace}.
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
      // Vertex-extrusion gain (see header). 0.05 on a unit-radius sphere
      // ([-1,1] height -> ±0.05 relief): clearly 3D / the no-erosion
      // toggle still changes the SHAPE, but no longer the exaggerated
      // ±0.12 bulge that over-dramatised the relief. Tune live with
      // setDebugDisplace.
      uDisplace: { value: 0.05 },
      // Stack map-mode uniforms. Defaults select the RELIEF path
      // (uStackMode 0), so a freshly-built material is byte-identical to
      // the pre-feature behaviour until App calls setDebugStack.
      uStackTex: { value: STACK_PLACEHOLDER_TEX as THREE.Texture },
      uChannel: { value: 0 },
      uStackMode: { value: 0 },
      uRamp: { value: 0 },
      uWindTime: { value: 0 },
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

/** Vertex-extrusion gain (height -> radial displacement). Default 0.05. */
export function setDebugDisplace(mat: THREE.ShaderMaterial, n: number): void {
  mat.uniforms.uDisplace.value = n;
  mat.uniformsNeedUpdate = true;
}

/** A selected stack channel + how to render it. `tex` null → placeholder. */
export interface DebugStackSel {
  tex: THREE.Texture | null;
  channel: number; // 0..3 — RGBA lane of `tex`
  mode: number; // 0 relief | 1 draped | 2 flat
  ramp: number; // 0 grey | 1 temp | 2 precip | 3 hue | 4 grey-elev
}

/**
 * Live-swap the stack channel/mode/ramp on an already-mounted material
 * (no re-bake). Mirrors {@link setDebugMapMode}. `mode 0` restores the
 * exact relief path regardless of the other fields.
 */
export function setDebugStack(
  mat: THREE.ShaderMaterial,
  sel: DebugStackSel,
): void {
  mat.uniforms.uStackTex.value = sel.tex ?? STACK_PLACEHOLDER_TEX;
  mat.uniforms.uChannel.value = sel.channel;
  mat.uniforms.uStackMode.value = sel.mode;
  mat.uniforms.uRamp.value = sel.ramp;
  mat.uniformsNeedUpdate = true;
}
