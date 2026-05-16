// GLSL pass library — Task A14 (Subsystem A, GPU port).
//
// =====================================================================
//  VERBATIM ALGORITHM MIRROR — DO NOT "IMPROVE", PARITY IS LOAD-BEARING
// =====================================================================
// Every exported string below is a GLSL ES 3.0 fragment-shader port of a
// committed Rust CPU-oracle function. The Rust oracle is AUTHORITATIVE:
//
//   apps/hayba-explorer/src-tauri/src/erosion/cubesphere.rs
//     - warp / unwarp / face_uv_to_sphere / sphere_to_face_uv / FACE_NEI
//   apps/hayba-explorer/src-tauri/src/erosion/pyramid.rs
//     - Field::neighbour / corner_neighbour_count
//     - corner_slope3 / great_circle / recv_and_slope
//     - inject_detail_band      -> DETAIL_BAND_FRAG
//     - stream_power_step       -> STREAM_POWER_FRAG
//     - thermal_step            -> THERMAL_FRAG
//     - upsample2x (+ PD fill)  -> UPSAMPLE_FRAG (+ fillPits)
//   apps/hayba-explorer/src-tauri/src/erosion/noise.rs
//     - hash3 / grad / fade / gradient_noise_raw / noise1
//     - fbm / ridged / worley / domain_warp
//   apps/hayba-explorer/src-tauri/src/erosion/resample.rs
//     - cubesphere_to_equirect  -> RESAMPLE_FRAG
//
// MIRROR PIN: this file mirrors the above at committed HEAD
//   15afe7a81f5245a8214af9f4f8f29c2885df5db0 (branch feat/baking-pipeline).
// Same formulas, constants, signs, branch order. The ONLY differences vs
// Rust are GLSL idiom + the 6-faces-in-one-2D-atlas texture addressing.
// A18 enforces CPU<->GPU parity (RMSE < 2e-3 over land); any change to the
// Rust oracle MUST be mirrored here or A18 fails. Same contract as
// cubesphere.ts's mirror-pin.
//
// ---------------------------------------------------------------------
//  64-bit hash emulation (noise.rs parity, NORMATIVE)
// ---------------------------------------------------------------------
// noise.rs hashes with `u64` splitmix64-style mixing (wrapping_mul of
// 64-bit constants, >>30/>>27/>>31 shifts, xor-fold). GLSL ES 3.0 has NO
// 64-bit integer type — only 32-bit `uint`. This is NOT ported as a
// divergent approximation: a `u64` is emulated EXACTLY as a `uvec2`
// (x=low32, y=high32) with bit-faithful 64-bit wrapping add / multiply /
// xor / logical-shift. The emulation reproduces Rust's `wrapping_*`
// semantics bit-for-bit, so the GPU noise field equals the CPU one within
// f32 (the only deliberate precision difference, matching cubesphere.ts).
//
// ---------------------------------------------------------------------
//  Atlas layout (6 faces in one 2D texture, tiled 3 wide x 2 tall)
// ---------------------------------------------------------------------
//   tileX = face % 3 ; tileY = face / 3   (face 0..5)
//   atlas uv = ( (tileX + faceU) / 3 , (tileY + faceV) / 2 )
// All passes operate on this layout; `faceTexelToSpherePos` and
// `neighbourTexel` encapsulate the addressing so the ports stay 1:1.
//
// ---------------------------------------------------------------------
//  No backticks anywhere in any GLSL string (the .glsl.ts footgun — a
//  stray backtick terminates the JS template literal). Comments use
//  /* */ and //. passes.glsl.test.ts guards this.
// ---------------------------------------------------------------------
//
// three.js compiles these with `glslVersion: THREE.GLSL3` (see
// pingpong.ts ensureMaterial), which injects `#version 300 es` and the
// `out` fragment declaration plumbing — so we DO NOT declare `#version`
// here (double declaration is a compile error). We declare our own
// `out vec4 fragColor;` (three GLSL3 path does not auto-name it).

/* ===================================================================
 *  SHARED CHUNK 0 — preamble (precision + atlas constants + fragColor)
 * =================================================================== */
const GLSL_PREAMBLE = [
  "precision highp float;",
  "precision highp int;",
  "out vec4 fragColor;",
  "",
  "/* Atlas tiling: 6 faces, 3 columns x 2 rows. */",
  "const float ATLAS_COLS = 3.0;",
  "const float ATLAS_ROWS = 2.0;",
  "",
  "/* uFaceRes = n (texels per face edge, this pass's resolution). */",
  "uniform float uFaceRes;",
  "",
].join("\n");

/* ===================================================================
 *  SHARED CHUNK 1 — exact u64 emulation (uvec2 lo/hi), noise.rs parity
 *
 *  Mirrors: noise.rs hash3 / fbm octave-seed / ridged octave-seed /
 *  worley seed offsets. Rust uses u64 wrapping arithmetic; we emulate
 *  it bit-faithfully. uvec2 v: v.x = low 32 bits, v.y = high 32 bits.
 * =================================================================== */
const GLSL_U64 = [
  "/* ---- exact 64-bit unsigned emulation (Rust u64 wrapping_*) ---- */",
  "uvec2 u64_add(uvec2 a, uvec2 b){",
  "  uint lo = a.x + b.x;",
  "  uint carry = (lo < a.x) ? 1u : 0u;   /* 32-bit wrap carry */",
  "  uint hi = a.y + b.y + carry;          /* wraps mod 2^32 */",
  "  return uvec2(lo, hi);",
  "}",
  "/* 64x64 -> low 64 wrapping multiply via 4 32x32 partial products. */",
  "uvec2 u64_mul(uvec2 a, uvec2 b){",
  "  uint a0 = a.x & 0xFFFFu, a1 = a.x >> 16;",
  "  uint b0 = b.x & 0xFFFFu, b1 = b.x >> 16;",
  "  /* low32 x low32 -> 64-bit (split to keep within 32-bit lanes). */",
  "  uint p00 = a0 * b0;",
  "  uint p01 = a0 * b1;",
  "  uint p10 = a1 * b0;",
  "  uint p11 = a1 * b1;",
  "  uint mid = (p00 >> 16) + (p01 & 0xFFFFu) + (p10 & 0xFFFFu);",
  "  uint lo  = (p00 & 0xFFFFu) | (mid << 16);",
  "  uint hiLL = p11 + (p01 >> 16) + (p10 >> 16) + (mid >> 16);",
  "  /* + (a.x*b.y + a.y*b.x) in the high word (low 32 bits only). */",
  "  uint hi = hiLL + a.x * b.y + a.y * b.x;",
  "  return uvec2(lo, hi);",
  "}",
  "uvec2 u64_xor(uvec2 a, uvec2 b){ return uvec2(a.x ^ b.x, a.y ^ b.y); }",
  "/* logical right shift by s in [0,63] (Rust u64 right-shift). */",
  "uvec2 u64_shr(uvec2 v, int s){",
  "  if (s == 0) return v;",
  "  if (s < 32){",
  "    uint lo = (v.x >> uint(s)) | (v.y << uint(32 - s));",
  "    uint hi = v.y >> uint(s);",
  "    return uvec2(lo, hi);",
  "  }",
  "  uint lo = v.y >> uint(s - 32);",
  "  return uvec2(lo, 0u);",
  "}",
  "/* Rust (i32 as u64): sign-extend into the high word. */",
  "uvec2 i32_to_u64(int v){",
  "  uint lo = uint(v);",
  "  uint hi = (v < 0) ? 0xFFFFFFFFu : 0u;",
  "  return uvec2(lo, hi);",
  "}",
  "uvec2 u64_const(uint hi, uint lo){ return uvec2(lo, hi); }",
  "",
  "/* hash3(ix,iy,iz,seed) -> u32  (noise.rs, verbatim mixing). */",
  "uint hash3(int ix, int iy, int iz, uvec2 seed){",
  "  /* h = seed",
  "       .wrapping_add(ix as u64 * 0x9E3779B97F4A7C15)",
  "       .wrapping_add(iy as u64 * 0x6C62272E07BB0142)",
  "       .wrapping_add(iz as u64 * 0x94D049BB133111EB) */",
  "  uvec2 h = seed;",
  "  h = u64_add(h, u64_mul(i32_to_u64(ix), u64_const(0x9E3779B9u,0x7F4A7C15u)));",
  "  h = u64_add(h, u64_mul(i32_to_u64(iy), u64_const(0x6C62272Eu,0x07BB0142u)));",
  "  h = u64_add(h, u64_mul(i32_to_u64(iz), u64_const(0x94D049BBu,0x133111EBu)));",
  "  /* finalizer (splitmix64-ish): */",
  "  h = u64_xor(h, u64_shr(h, 30));",
  "  h = u64_mul(h, u64_const(0xBF58476Du,0x1CE4E5B9u));",
  "  h = u64_xor(h, u64_shr(h, 27));",
  "  h = u64_mul(h, u64_const(0x94D049BBu,0x133111EBu));",
  "  h = u64_xor(h, u64_shr(h, 31));",
  "  /* (h ^ (h >> 32)) as u32  ==  low32 ^ high32 */",
  "  return h.x ^ h.y;",
  "}",
  "",
].join("\n");

/* ===================================================================
 *  SHARED CHUNK 2 — noise set (noise.rs verbatim port)
 *  grad / fade / gradient_noise_raw / noise1 / fbm / ridged / worley /
 *  domainWarp. Sphere-position domain, deterministic by uSeed (uvec2).
 * =================================================================== */
const GLSL_NOISE = [
  "/* grad(h): 12 cube-edge gradient directions, indexed by h % 12. */",
  "vec3 grad(uint h){",
  "  uint i = h % 12u;",
  "  if (i == 0u)  return vec3( 1.0,  1.0,  0.0);",
  "  if (i == 1u)  return vec3(-1.0,  1.0,  0.0);",
  "  if (i == 2u)  return vec3( 1.0, -1.0,  0.0);",
  "  if (i == 3u)  return vec3(-1.0, -1.0,  0.0);",
  "  if (i == 4u)  return vec3( 1.0,  0.0,  1.0);",
  "  if (i == 5u)  return vec3(-1.0,  0.0,  1.0);",
  "  if (i == 6u)  return vec3( 1.0,  0.0, -1.0);",
  "  if (i == 7u)  return vec3(-1.0,  0.0, -1.0);",
  "  if (i == 8u)  return vec3( 0.0,  1.0,  1.0);",
  "  if (i == 9u)  return vec3( 0.0, -1.0,  1.0);",
  "  if (i == 10u) return vec3( 0.0,  1.0, -1.0);",
  "  return vec3( 0.0, -1.0, -1.0);",
  "}",
  "/* quintic fade — C2 smoothstep. */",
  "float fade(float t){ return t*t*t*(t*(t*6.0 - 15.0) + 10.0); }",
  "float nlerp(float a, float b, float t){ return a + t*(b - a); }",
  "",
  "/* gradient_noise_raw(pos, seed) — 3D Perlin-style on integer lattice. */",
  "float gradient_noise_raw(vec3 p, uvec2 seed){",
  "  /* Rust: pos.x.floor() as i32 (truncates toward -inf via floor). */",
  "  int fx = int(floor(p.x));",
  "  int fy = int(floor(p.y));",
  "  int fz = int(floor(p.z));",
  "  float dx = p.x - float(fx);",
  "  float dy = p.y - float(fy);",
  "  float dz = p.z - float(fz);",
  "  float u = fade(dx);",
  "  float v = fade(dy);",
  "  float w = fade(dz);",
  "  float g000 = dot(grad(hash3(fx,   fy,   fz,   seed)), vec3(dx,       dy,       dz      ));",
  "  float g100 = dot(grad(hash3(fx+1, fy,   fz,   seed)), vec3(dx-1.0,   dy,       dz      ));",
  "  float g010 = dot(grad(hash3(fx,   fy+1, fz,   seed)), vec3(dx,       dy-1.0,   dz      ));",
  "  float g110 = dot(grad(hash3(fx+1, fy+1, fz,   seed)), vec3(dx-1.0,   dy-1.0,   dz      ));",
  "  float g001 = dot(grad(hash3(fx,   fy,   fz+1, seed)), vec3(dx,       dy,       dz-1.0  ));",
  "  float g101 = dot(grad(hash3(fx+1, fy,   fz+1, seed)), vec3(dx-1.0,   dy,       dz-1.0  ));",
  "  float g011 = dot(grad(hash3(fx,   fy+1, fz+1, seed)), vec3(dx,       dy-1.0,   dz-1.0  ));",
  "  float g111 = dot(grad(hash3(fx+1, fy+1, fz+1, seed)), vec3(dx-1.0,   dy-1.0,   dz-1.0  ));",
  "  float x00 = nlerp(g000, g100, u);",
  "  float x10 = nlerp(g010, g110, u);",
  "  float x01 = nlerp(g001, g101, u);",
  "  float x11 = nlerp(g011, g111, u);",
  "  float y0 = nlerp(x00, x10, v);",
  "  float y1 = nlerp(x01, x11, v);",
  "  return nlerp(y0, y1, w);",
  "}",
  "",
  "/* NOISE_SCALE = 1.0 / 0.7  (noise.rs). */",
  "const float NOISE_SCALE = 1.0 / 0.7;",
  "float noise1(vec3 p, uvec2 seed){",
  "  return clamp(gradient_noise_raw(p, seed) * NOISE_SCALE, -1.0, 1.0);",
  "}",
  "",
  "/* octave-seed mixers: seed.wrapping_add(i * CONST), all u64. */",
  "uvec2 fbm_oct_seed(uvec2 seed, uint i){",
  "  return u64_add(seed, u64_mul(uvec2(i,0u), u64_const(0x9E3779B9u,0x7F4A7C15u)));",
  "}",
  "uvec2 ridged_oct_seed(uvec2 seed, uint i){",
  "  uvec2 s = u64_add(seed, u64_const(0xDEADBEEFu,0xCAFE0000u));",
  "  return u64_add(s, u64_mul(uvec2(i,0u), u64_const(0x6C62272Eu,0x07BB0142u)));",
  "}",
  "",
  "/* fbm(pos, octaves, seed) -> [0,1].  (noise.rs verbatim) */",
  "float fbm(vec3 pos, int octaves, uvec2 seed){",
  "  if (octaves == 0) return 0.5;",
  "  float value = 0.0;",
  "  float amplitude = 0.5;",
  "  float frequency = 1.0;",
  "  float max_value = 0.0;",
  "  for (int i = 0; i < octaves; i++){",
  "    uvec2 oct_seed = fbm_oct_seed(seed, uint(i));",
  "    value += amplitude * noise1(pos * frequency, oct_seed);",
  "    max_value += amplitude;",
  "    amplitude *= 0.5;",
  "    frequency *= 2.0;",
  "  }",
  "  return clamp((value / max_value) * 0.5 + 0.5, 0.0, 1.0);",
  "}",
  "",
  "/* ridged(pos, octaves, seed) -> [0,1].  (noise.rs verbatim) */",
  "float ridged(vec3 pos, int octaves, uvec2 seed){",
  "  float value = 0.0;",
  "  float amplitude = 0.5;",
  "  float frequency = 1.0;",
  "  float max_value = 0.0;",
  "  float weight = 1.0;",
  "  for (int i = 0; i < octaves; i++){",
  "    uvec2 oct_seed = ridged_oct_seed(seed, uint(i));",
  "    float n = noise1(pos * frequency, oct_seed);",
  "    float signal = (1.0 - abs(n)) * weight;",
  "    value += signal * amplitude;",
  "    max_value += amplitude;",
  "    float sw = clamp(signal * 2.0, 0.0, 1.0);",
  "    weight = sw * sw;",
  "    amplitude *= 0.5;",
  "    frequency *= 2.0;",
  "  }",
  "  if (max_value > 0.0) return clamp(value / max_value, 0.0, 1.0);",
  "  return 0.0;",
  "}",
  "",
  "/* worley(pos, seed) -> [0,1] (F1).  (noise.rs verbatim) */",
  "float worley(vec3 pos, uvec2 seed){",
  "  vec3 sp = pos; /* scale == 1.0 */",
  "  int fx = int(floor(sp.x));",
  "  int fy = int(floor(sp.y));",
  "  int fz = int(floor(sp.z));",
  "  float min_dist_sq = 3.4028235e38;",
  "  for (int dz = -1; dz <= 1; dz++){",
  "    for (int dy = -1; dy <= 1; dy++){",
  "      for (int dx = -1; dx <= 1; dx++){",
  "        int cx = fx + dx;",
  "        int cy = fy + dy;",
  "        int cz = fz + dz;",
  "        uint h0 = hash3(cx, cy, cz, seed);",
  "        uint h1 = hash3(cx, cy, cz, u64_add(seed, u64_const(0x12345678u,0x9ABCDEF0u)));",
  "        uint h2 = hash3(cx, cy, cz, u64_add(seed, u64_const(0xFEDCBA98u,0x76543210u)));",
  "        float jx = float(h0 & 0xFFFFu) / 65535.0;",
  "        float jy = float(h1 & 0xFFFFu) / 65535.0;",
  "        float jz = float(h2 & 0xFFFFu) / 65535.0;",
  "        vec3 fp = vec3(float(cx)+jx, float(cy)+jy, float(cz)+jz);",
  "        vec3 dlt = sp - fp;",
  "        float d2 = dot(dlt, dlt);",
  "        if (d2 < min_dist_sq) min_dist_sq = d2;",
  "      }",
  "    }",
  "  }",
  "  float max_dist = sqrt(3.0);",
  "  return clamp(sqrt(min_dist_sq) / max_dist, 0.0, 1.0);",
  "}",
  "",
  "/* domain_warp(pos, seed) -> Vec3.  (noise.rs verbatim) */",
  "vec3 domainWarp(vec3 pos, uvec2 seed){",
  "  uvec2 sx = u64_add(seed, u64_const(0x11111111u,0x11111111u));",
  "  uvec2 sy = u64_add(seed, u64_const(0x22222222u,0x22222222u));",
  "  uvec2 sz = u64_add(seed, u64_const(0x33333333u,0x33333333u));",
  "  float warp_strength = 0.25;",
  "  float wx = (fbm(pos, 3, sx) * 2.0 - 1.0) * warp_strength;",
  "  float wy = (fbm(pos, 3, sy) * 2.0 - 1.0) * warp_strength;",
  "  float wz = (fbm(pos, 3, sz) * 2.0 - 1.0) * warp_strength;",
  "  return pos + vec3(wx, wy, wz);",
  "}",
  "",
].join("\n");

/* ===================================================================
 *  SHARED CHUNK 3 — cube-sphere geometry (cubesphere.rs verbatim)
 *  warp / unwarp / faceUvToSphere / sphereToFaceUv / FACE_NEI.
 * =================================================================== */
const GLSL_CUBESPHERE = [
  "/* FACE_NEI: [[5,4,2,3],[4,5,2,3],[0,1,5,4],[0,1,4,5],[0,1,2,3],[1,0,2,3]] */",
  "int faceNei(int f, int dir){",
  "  /* dir: 0=right 1=left 2=up 3=down (cubesphere.rs FACE_NEI). */",
  "  if (f == 0){ int t[4] = int[4](5,4,2,3); return t[dir]; }",
  "  if (f == 1){ int t[4] = int[4](4,5,2,3); return t[dir]; }",
  "  if (f == 2){ int t[4] = int[4](0,1,5,4); return t[dir]; }",
  "  if (f == 3){ int t[4] = int[4](0,1,4,5); return t[dir]; }",
  "  if (f == 4){ int t[4] = int[4](0,1,2,3); return t[dir]; }",
  "  int t[4] = int[4](1,0,2,3); return t[dir];",
  "}",
  "/* warp(a) = tan(a * PI/4) ; unwarp(a) = atan(a) * 4/PI  (FRAC_PI_4). */",
  "const float PI = 3.14159265358979323846;",
  "float cs_warp(float a){ return tan(a * (PI / 4.0)); }",
  "float cs_unwarp(float a){ return atan(a) * (4.0 / PI); }",
  "",
  "/* faceUvToSphere — cubesphere.rs face_uv_to_sphere, verbatim. */",
  "vec3 faceUvToSphere(int face, float u, float v){",
  "  float a = cs_warp(2.0*u - 1.0);",
  "  float b = cs_warp(2.0*v - 1.0);",
  "  vec3 d;",
  "  if      (face == 0) d = vec3( 1.0,   b,  -a);",
  "  else if (face == 1) d = vec3(-1.0,   b,   a);",
  "  else if (face == 2) d = vec3(  a, 1.0,  -b);",
  "  else if (face == 3) d = vec3(  a,-1.0,   b);",
  "  else if (face == 4) d = vec3(  a,   b, 1.0);",
  "  else                d = vec3( -a,   b,-1.0);",
  "  return normalize(d);",
  "}",
  "",
  "/* sphereToFaceUv — cubesphere.rs sphere_to_face_uv, verbatim. */",
  "void sphereToFaceUv(vec3 p, out int face, out float ou, out float ov){",
  "  float ax = abs(p.x), ay = abs(p.y), az = abs(p.z);",
  "  float a; float b;",
  "  if (ax >= ay && ax >= az){",
  "    if (p.x > 0.0){ face = 0; a = -p.z/ax; b = p.y/ax; }",
  "    else          { face = 1; a =  p.z/ax; b = p.y/ax; }",
  "  } else if (ay >= az){",
  "    if (p.y > 0.0){ face = 2; a = p.x/ay; b = -p.z/ay; }",
  "    else          { face = 3; a = p.x/ay; b =  p.z/ay; }",
  "  } else if (p.z > 0.0){ face = 4; a = p.x/az; b = p.y/az; }",
  "  else                 { face = 5; a = -p.x/az; b = p.y/az; }",
  "  ou = 0.5 * (cs_unwarp(a) + 1.0);",
  "  ov = 0.5 * (cs_unwarp(b) + 1.0);",
  "}",
  "",
].join("\n");

/* ===================================================================
 *  SHARED CHUNK 4 — atlas addressing + neighbourTexel + sampling
 *
 *  faceTexelToSpherePos : (port of face_uv_to_sphere + 3x2 atlas tile
 *      indexing) — given an atlas fragment, recover (face,i,j) and the
 *      texel-centre sphere position.
 *  neighbourTexel       : mirrors Field::neighbour (cubesphere round-trip
 *      seam resolve) + corner_neighbour_count (3-way corner detection).
 *  tap2D                : explicit 4-tap manual bilinear gated by
 *      uManualBilinear (the OES_texture_float_linear A12 fallback).
 *  fetchH               : read h (channel .r) of texel (face,i,j).
 * =================================================================== */
const GLSL_ATLAS = [
  "uniform sampler2D uState; /* RGBA32F atlas: r=h, g=water, b=sed, a=ocean(>0.5) */",
  "uniform vec2 uAtlasTexel; /* 1.0 / atlasTextureSize (for tap2D taps) */",
  "uniform int uManualBilinear; /* 1 = explicit 4-tap (no OES_texture_float_linear) */",
  "",
  "/* face cell (i,j) -> atlas UV of that texel centre (3x2 tiling). */",
  "vec2 faceCellToAtlasUv(int face, int i, int j){",
  "  float n = uFaceRes;",
  "  float fu = (float(i) + 0.5) / n;",
  "  float fv = (float(j) + 0.5) / n;",
  "  float tileX = float(face - 3 * (face / 3)); /* face % 3 */",
  "  float tileY = float(face / 3);              /* face / 3 */",
  "  return vec2((tileX + fu) / ATLAS_COLS, (tileY + fv) / ATLAS_ROWS);",
  "}",
  "/* face (u,v) in [0,1] -> atlas UV (continuous, for bilinear fetch). */",
  "vec2 faceUvToAtlasUv(int face, float fu, float fv){",
  "  float tileX = float(face - 3 * (face / 3));",
  "  float tileY = float(face / 3);",
  "  return vec2((tileX + fu) / ATLAS_COLS, (tileY + fv) / ATLAS_ROWS);",
  "}",
  "",
  "/* tap2D: explicit 4-tap bilinear when uManualBilinear, else hw texture(). */",
  "vec4 tap2D(sampler2D t, vec2 uv, vec2 texel){",
  "  if (uManualBilinear == 0){ return texture(t, uv); }",
  "  vec2 px = uv / texel - 0.5;",
  "  vec2 fl = floor(px);",
  "  vec2 fr = px - fl;",
  "  vec2 b0 = (fl + 0.5) * texel;",
  "  vec4 s00 = texture(t, b0);",
  "  vec4 s10 = texture(t, b0 + vec2(texel.x, 0.0));",
  "  vec4 s01 = texture(t, b0 + vec2(0.0, texel.y));",
  "  vec4 s11 = texture(t, b0 + texel);",
  "  vec4 a = mix(s00, s10, fr.x);",
  "  vec4 bb = mix(s01, s11, fr.x);",
  "  return mix(a, bb, fr.y);",
  "}",
  "",
  "/* Decode this fragment's atlas position -> (face,i,j) + sphere pos.",
  "   Port of: face_uv_to_sphere at texel centre + atlas tile indexing. */",
  "void faceTexelToSpherePos(vec2 atlasUv, out int face, out int ci, out int cj,",
  "                          out vec3 pos){",
  "  float n = uFaceRes;",
  "  /* atlasUv -> tile + in-tile uv. */",
  "  vec2 g = atlasUv * vec2(ATLAS_COLS, ATLAS_ROWS);",
  "  int tileX = int(floor(g.x));",
  "  int tileY = int(floor(g.y));",
  "  tileX = clamp(tileX, 0, 2);",
  "  tileY = clamp(tileY, 0, 1);",
  "  face = tileY * 3 + tileX;",
  "  float fu = g.x - float(tileX);",
  "  float fv = g.y - float(tileY);",
  "  ci = clamp(int(floor(fu * n)), 0, int(n) - 1);",
  "  cj = clamp(int(floor(fv * n)), 0, int(n) - 1);",
  "  float u = (float(ci) + 0.5) / n;",
  "  float v = (float(cj) + 0.5) / n;",
  "  pos = faceUvToSphere(face, u, v);",
  "}",
  "",
  "/* corner_neighbour_count == 3 test: (i,j) both on a face edge. */",
  "bool isCorner(int i, int j){",
  "  int n = int(uFaceRes);",
  "  bool oi = (i == 0) || (i == n - 1);",
  "  bool oj = (j == 0) || (j == n - 1);",
  "  return oi && oj;",
  "}",
  "",
  "/* neighbourTexel — Field::neighbour: in-face when 0<=i,j<n; else the",
  "   off-edge UV centre is projected through the real cube-sphere",
  "   geometry and re-resolved (handles the per-edge axis swap/flip). */",
  "void neighbourTexel(int f, int i, int j, out int nf, out int ni, out int nj){",
  "  int n = int(uFaceRes);",
  "  if (i >= 0 && i < n && j >= 0 && j < n){ nf = f; ni = i; nj = j; return; }",
  "  float inv = 1.0 / uFaceRes;",
  "  float u = (float(i) + 0.5) * inv;",
  "  float v = (float(j) + 0.5) * inv;",
  "  vec3 p = faceUvToSphere(f, u, v);",
  "  float su; float sv; int sf;",
  "  sphereToFaceUv(p, sf, su, sv);",
  "  int ii = clamp(int(floor(su * uFaceRes)), 0, n - 1);",
  "  int jj = clamp(int(floor(sv * uFaceRes)), 0, n - 1);",
  "  nf = sf; ni = ii; nj = jj;",
  "}",
  "",
  "/* Raw fetch of (face,i,j) state via nearest tap (cell-centred). */",
  "vec4 fetchCell(int face, int i, int j){",
  "  return texture(uState, faceCellToAtlasUv(face, i, j));",
  "}",
  "float fetchH(int face, int i, int j){ return fetchCell(face,i,j).r; }",
  "bool  isOceanCell(int face, int i, int j){ return fetchCell(face,i,j).a > 0.5; }",
  "",
  "/* great_circle(a,b) = acos(clamp(dot(norm a, norm b), -1, 1)). */",
  "float greatCircle(vec3 a, vec3 b){",
  "  return acos(clamp(dot(normalize(a), normalize(b)), -1.0, 1.0));",
  "}",
  "",
  "/* sphere centre of a cell (bit-identical inputs to faceUvToSphere). */",
  "vec3 cellPos(int face, int i, int j){",
  "  float inv = 1.0 / uFaceRes;",
  "  return faceUvToSphere(face, (float(i)+0.5)*inv, (float(j)+0.5)*inv);",
  "}",
  "",
  "/* cell_solid_angle(c): |(pu-p) x (pv-p)|, step s = 1/n. */",
  "float cellSolidAngle(int face, int i, int j){",
  "  float s = 1.0 / uFaceRes;",
  "  float u = (float(i)+0.5)*s;",
  "  float v = (float(j)+0.5)*s;",
  "  vec3 p  = faceUvToSphere(face, u, v);",
  "  vec3 pu = faceUvToSphere(face, u+s, v);",
  "  vec3 pv = faceUvToSphere(face, u, v+s);",
  "  return length(cross(pu - p, pv - p));",
  "}",
  "",
  "/* gather the (up to 4) distinct real edge neighbours of (f,i,j).",
  "   Mirrors gather_neighbours: 4 axis steps via neighbourTexel, drop",
  "   any that clamp back onto self or duplicate (de-dup). Returns count",
  "   and fills nf/ni/nj arrays. */",
  "int gatherNeighbours(int f, int i, int j, out int nf[4], out int ni[4], out int nj[4]){",
  "  int here_f = f, here_i = i, here_j = j;",
  "  int cnt = 0;",
  "  ivec2 steps[4] = ivec2[4](ivec2(1,0), ivec2(-1,0), ivec2(0,1), ivec2(0,-1));",
  "  for (int s = 0; s < 4; s++){",
  "    int af, ai, aj;",
  "    neighbourTexel(f, i + steps[s].x, j + steps[s].y, af, ai, aj);",
  "    if (af == here_f && ai == here_i && aj == here_j) continue;",
  "    bool dup = false;",
  "    for (int q = 0; q < cnt; q++){",
  "      if (nf[q]==af && ni[q]==ai && nj[q]==aj){ dup = true; break; }",
  "    }",
  "    if (dup) continue;",
  "    nf[cnt]=af; ni[cnt]=ai; nj[cnt]=aj; cnt++;",
  "  }",
  "  return cnt;",
  "}",
  "",
].join("\n");

/* ===================================================================
 *  SHARED CHUNK 5 — cornerSlope3 (pyramid.rs corner_slope3, verbatim)
 *  Least-squares tangent plane through the 3 real corner neighbours.
 * =================================================================== */
const GLSL_CORNER_SLOPE = [
  "/* cornerSlope3 — pyramid.rs corner_slope3 (3-vertex plane fit).",
  "   Solves the 2x2 normal equations of [tu tv]*[a b]^T = dh in the",
  "   orthonormal tangent basis at p0; returns slope magnitude ||(a,b)||.",
  "   nbrF/I/J = the gathered neighbours (cnt of them), h0 = h at p0. */",
  "float cornerSlope3(vec3 p0, float h0, int cnt,",
  "                   int nbrF[4], int nbrI[4], int nbrJ[4]){",
  "  vec3 nrm = normalize(p0);",
  "  vec3 helper = (abs(nrm.x) < 0.9) ? vec3(1.0,0.0,0.0) : vec3(0.0,1.0,0.0);",
  "  vec3 e1 = normalize(helper - nrm * dot(helper, nrm));",
  "  vec3 e2 = cross(nrm, e1);",
  "  float sxx = 0.0, sxy = 0.0, syy = 0.0, bx = 0.0, by = 0.0;",
  "  for (int k = 0; k < 4; k++){",
  "    if (k >= cnt) break;",
  "    vec3 pk = cellPos(nbrF[k], nbrI[k], nbrJ[k]);",
  "    vec3 dd = pk - p0;",
  "    float tu = dot(dd, e1);",
  "    float tv = dot(dd, e2);",
  "    float dh = fetchH(nbrF[k], nbrI[k], nbrJ[k]) - h0;",
  "    sxx += tu*tu; sxy += tu*tv; syy += tv*tv;",
  "    bx  += tu*dh; by  += tv*dh;",
  "  }",
  "  float det = sxx*syy - sxy*sxy;",
  "  if (abs(det) < 1e-20){",
  "    /* colinear fallback: largest single-neighbour great-circle slope. */",
  "    float sv = 0.0;",
  "    for (int k = 0; k < 4; k++){",
  "      if (k >= cnt) break;",
  "      vec3 pk = cellPos(nbrF[k], nbrI[k], nbrJ[k]);",
  "      float dist = greatCircle(p0, pk);",
  "      if (dist > 1e-9){",
  "        sv = max(sv, abs((h0 - fetchH(nbrF[k],nbrI[k],nbrJ[k])) / dist));",
  "      }",
  "    }",
  "    return sv;",
  "  }",
  "  float a = (syy*bx - sxy*by) / det;",
  "  float b = (sxx*by - sxy*bx) / det;",
  "  float s = sqrt(a*a + b*b);",
  "  return (s == s && abs(s) < 3.4028235e38) ? s : 0.0; /* finite guard */",
  "}",
  "",
].join("\n");

/* ===================================================================
 *  SHARED CHUNK 6 — fillPits (A9 §5.4 PD pit-fill, NORMATIVE)
 *
 *  pyramid.rs runs Planchon-Darboux as an UNBOUNDED Gauss-Seidel sweep
 *  loop (`for _ in 0..sweep_cap`) over the whole field until no cell
 *  changes. A single fragment invocation CANNOT iterate the whole atlas.
 *  Per the A14 spec ("structure it as the plan/§6-flow-accum hardening
 *  implies — bounded passes, NOT an unbounded loop in one fragment
 *  invocation"), fillPits is the PER-TEXEL PD RELAXATION KERNEL: one
 *  `w[k] = max(h[k], min filled neighbour)` step reading the previous
 *  iteration's `w` from a ping-pong texture. The A15 orchestrator runs
 *  it as N bounded ping-pong passes (the Jacobi analogue of the Rust
 *  Gauss-Seidel sweep; same fixed point: every non-outlet land cell ends
 *  with a neighbour at <= its height). uPrevW samples the previous PD
 *  iterate; uGlobalMinLand is the land global-min outlet level (computed
 *  by the orchestrator, same as Rust `global_min`).",
 *
 *  This is the Jacobi form of the IDENTICAL PD fixed-point equation, not
 *  a divergent approximation — at convergence it satisfies exactly the
 *  Rust post-condition (`w[k] = max(h[k], min_nb w)`, ocean fixed
 *  Dirichlet, global-min land cell a fixed outlet).
 * =================================================================== */
const GLSL_FILLPITS = [
  "uniform sampler2D uPrevW;     /* previous PD iterate (r = w). */",
  "uniform float uGlobalMinLand; /* min land h over the fine field. */",
  "",
  "float prevW(int face, int i, int j){",
  "  return texture(uPrevW, faceCellToAtlasUv(face, i, j)).r;",
  "}",
  "",
  "/* One Planchon-Darboux relaxation step for cell (f,i,j) with post-",
  "   bilinear height hk. is_land = hk >= 0.0 (rasterize_from_cells rule).",
  "   Ocean: fixed Dirichlet (w = hk). global-min land cell: fixed outlet",
  "   (w = hk). Interior land: w = max(hk, min over real neighbours of",
  "   prevW). Initial uPrevW must be +inf on interior land / hk elsewhere",
  "   (orchestrator seeds it, exactly as Rust seeds the w buffer). */",
  "float fillPits(int f, int i, int j, float hk){",
  "  bool land = hk >= 0.0;",
  "  if (!land) return hk; /* ocean: never raised */",
  "  if (hk <= uGlobalMinLand + 1e-9) return hk; /* fixed outlet */",
  "  int nf[4]; int ni[4]; int nj[4];",
  "  int cnt = gatherNeighbours(f, i, j, nf, ni, nj);",
  "  float min_nb = 3.4028235e38;",
  "  for (int k = 0; k < 4; k++){",
  "    if (k >= cnt) break;",
  "    float wn = prevW(nf[k], ni[k], nj[k]);",
  "    if (wn < min_nb) min_nb = wn;",
  "  }",
  "  float cand = (hk > min_nb) ? hk : min_nb;",
  "  float wprev = prevW(f, i, j);",
  "  /* monotone-non-increasing toward the fixed point (Rust PD step). */",
  "  return (cand < wprev) ? cand : wprev;",
  "}",
  "",
].join("\n");

/* The full shared prelude every pass concatenates (order matters: u64 ->
 * noise -> cubesphere -> atlas -> cornerSlope3). fillPits is appended only
 * by the upsample pass (it needs uPrevW/uGlobalMinLand). */
const GLSL_PRELUDE =
  GLSL_PREAMBLE +
  GLSL_U64 +
  GLSL_NOISE +
  GLSL_CUBESPHERE +
  GLSL_ATLAS +
  GLSL_CORNER_SLOPE;

/* ===================================================================
 *  PASS 1 — DETAIL_BAND_FRAG  (port of inject_detail_band, A6)
 *
 *  per land texel:
 *    fbm_c     = fbm(pos, level+2, seed)*2 - 1
 *    s         = clamp(slope01, 0, 1)
 *    ridged_env= ridged(pos, level+2, seed)
 *    noise_val = fbm_c * (1 + s*ridged_env)
 *    h += amp * s * noise_val
 *  Ocean untouched. uSeed already == cfg.seed ^ level (orchestrator
 *  XORs it, matching `cfg.seed ^ level as u64`). slope01 is supplied
 *  per-texel in uState.g (the orchestrator writes it there, same value
 *  the CPU slope pass produces).
 * =================================================================== */
export const DETAIL_BAND_FRAG: string =
  GLSL_PRELUDE +
  [
    "uniform vec2 uResolution;   /* atlas render-target size in px. */",
    "uniform uvec2 uSeed;        /* cfg.seed ^ level, as u64 (lo,hi packed). */",
    "uniform int  uLevel;        /* pyramid level (octaves = level + 2). */",
    "uniform float uAmp;         /* injection amplitude. */",
    "",
    "void main(){",
    "  vec2 atlasUv = gl_FragCoord.xy / uResolution;",
    "  int face, ci, cj; vec3 pos;",
    "  faceTexelToSpherePos(atlasUv, face, ci, cj, pos);",
    "  vec4 st = fetchCell(face, ci, cj);",
    "  float h = st.r;",
    "  bool ocean = st.a > 0.5;",
    "  if (ocean){ fragColor = st; return; } /* ocean texels untouched */",
    "  int octaves = uLevel + 2;",
    "  float fbm_c = fbm(pos, octaves, uSeed) * 2.0 - 1.0;",
    "  float s = clamp(st.g, 0.0, 1.0); /* slope01 carried in .g */",
    "  float ridged_env = ridged(pos, octaves, uSeed);",
    "  float noise_val = fbm_c * (1.0 + s * ridged_env);",
    "  h += uAmp * s * noise_val;",
    "  fragColor = vec4(h, st.g, st.b, st.a);",
    "}",
  ].join("\n");

/* ===================================================================
 *  PASS 2 — STREAM_POWER_FRAG  (port of stream_power_step, A7)
 *
 *  PARITY NOTE (NORMATIVE): the Rust pass is a 3-phase GLOBAL algorithm
 *  (receivers -> O(N) Braun-Willett drainage-area accumulation over the
 *  receiver forest -> clamped incision). Drainage area is a global
 *  prefix-sum over a forest; a single fragment cannot accumulate it.
 *  The A15 orchestrator therefore supplies the per-cell drainage area
 *  `A` in uState.b (it runs the receiver + Braun-Willett accumulation as
 *  its own bounded multi-pass step, exactly the Rust Pass-1/Pass-2 — the
 *  flow-accum hardening the §6 plan calls for). THIS fragment is the
 *  faithful port of Rust Pass-1 (receiver+slope, incl. the cornerSlope3
 *  branch) AND Pass-3 (clamped incision, U=0, floor at receiver & 0).
 *  Identical formula/constants/signs — only the global A prefix-sum is
 *  delegated upstream (it cannot exist in one fragment invocation).
 *
 *  uState channels for this pass: r=h, g=slope01(unused here), b=A
 *  (drainage area, orchestrator-supplied), a=ocean.
 * =================================================================== */
export const STREAM_POWER_FRAG: string =
  GLSL_PRELUDE +
  [
    "uniform vec2 uResolution;",
    "uniform float uErodibility;   /* cfg.erodibility (K). */",
    "uniform float uAreaExp;       /* cfg.area_exp (m). */",
    "uniform float uSlopeExp;      /* cfg.slope_exp (n). */",
    "uniform float uIncisionClamp; /* cfg.incision_clamp (eps). */",
    "",
    "void main(){",
    "  vec2 atlasUv = gl_FragCoord.xy / uResolution;",
    "  int face, ci, cj; vec3 p0;",
    "  faceTexelToSpherePos(atlasUv, face, ci, cj, p0);",
    "  vec4 st = fetchCell(face, ci, cj);",
    "  float h0 = st.r;",
    "  bool ocean = st.a > 0.5;",
    "  if (ocean){ fragColor = st; return; } /* ocean fixed base level */",
    "",
    "  /* Pass 1: steepest-descent receiver + slope (recv_and_slope). */",
    "  int nf[4]; int ni[4]; int nj[4];",
    "  int cnt = gatherNeighbours(face, ci, cj, nf, ni, nj);",
    "  float best_slope = 0.0;",
    "  int best_k = -1;",
    "  for (int k = 0; k < 4; k++){",
    "    if (k >= cnt) break;",
    "    float hk = fetchH(nf[k], ni[k], nj[k]);",
    "    float drop = h0 - hk;",
    "    if (drop <= 0.0) continue;",
    "    vec3 pk = cellPos(nf[k], ni[k], nj[k]);",
    "    float dist = greatCircle(p0, pk);",
    "    if (dist <= 1e-9) continue;",
    "    float s = drop / dist;",
    "    if (s > best_slope){ best_slope = s; best_k = k; }",
    "  }",
    "  if (best_k < 0){ fragColor = st; return; } /* sink: no incision */",
    "  float slope = best_slope;",
    "  /* 3-way cube corner: slope magnitude from cornerSlope3 plane fit. */",
    "  if (isCorner(ci, cj)){",
    "    float cs = cornerSlope3(p0, h0, cnt, nf, ni, nj);",
    "    if (cs == cs && abs(cs) < 3.4028235e38) slope = cs;",
    "  }",
    "  /* receiver height = h of the steepest real neighbour. */",
    "  float h_recv = fetchH(nf[best_k], ni[best_k], nj[best_k]);",
    "",
    "  /* Pass 3: clamped incision (U=0). A supplied in st.b by A15. */",
    "  float area = st.b;",
    "  float s = max(slope, 0.0);",
    "  if (s <= 0.0){ fragColor = st; return; }",
    "  float dz = uErodibility * pow(area, uAreaExp) * pow(s, uSlopeExp);",
    "  if (!(dz == dz) || abs(dz) >= 3.4028235e38){ fragColor = st; return; }",
    "  float incision = min(dz, uIncisionClamp); /* |dz| <= eps, dz>=0 */",
    "  float floorH = max(h_recv, 0.0);          /* never below recv or 0 */",
    "  float hOut = max(h0 - incision, floorH);",
    "  fragColor = vec4(hOut, st.g, st.b, st.a);",
    "}",
  ].join("\n");

/* ===================================================================
 *  PASS 3 — THERMAL_FRAG  (port of thermal_step, A8)
 *
 *  Mass-conserving FV Laplacian. The Rust impl builds an explicit
 *  unordered land-land edge set and applies +F/-F antisymmetrically so
 *  Sum(delta)==0 by construction. A fragment shader is per-CELL: it
 *  recomputes, for cell k, the sum of fluxes over its real land
 *  neighbours. Because the flux F_ij = w*(h_j - h_i) is antisymmetric
 *  and each (CFL-capped) edge weight is computed identically from BOTH
 *  endpoints (same OLD field, same talus gate, same w_cap), the per-cell
 *  gather reproduces exactly Rust's delta[k] = Sum_j F(k,j) — mass is
 *  conserved over the whole field by the same antisymmetry (no edge is
 *  double-applied; each cell sums only ITS incident edges). 3-way cube
 *  corner: slope from cornerSlope3 (the missing 4th edge is never
 *  zero-filled — gatherNeighbours yields only the real edges).
 *  CFL_SUM=0.5, MAX_DEGREE=4 -> w_cap=0.125 (verbatim constants).
 * =================================================================== */
export const THERMAL_FRAG: string =
  GLSL_PRELUDE +
  [
    "uniform vec2 uResolution;",
    "uniform float uThermalD;    /* cfg.thermal_d. */",
    "uniform float uTalusAngle;  /* cfg.talus_angle. */",
    "",
    "const float CFL_SUM = 0.5;",
    "const float MAX_DEGREE = 4.0;",
    "",
    "/* corner slope for an arbitrary corner endpoint (gathers its own",
    "   neighbour ring, mirrors the Rust cbuf path in thermal_step). */",
    "float cornerSlopeAt(int cf, int ci2, int cj2){",
    "  vec3 cp0 = cellPos(cf, ci2, cj2);",
    "  float ch0 = fetchH(cf, ci2, cj2);",
    "  int cnf[4]; int cni[4]; int cnj[4];",
    "  int ccnt = gatherNeighbours(cf, ci2, cj2, cnf, cni, cnj);",
    "  return cornerSlope3(cp0, ch0, ccnt, cnf, cni, cnj);",
    "}",
    "",
    "void main(){",
    "  vec2 atlasUv = gl_FragCoord.xy / uResolution;",
    "  int face, ci, cj; vec3 pa;",
    "  faceTexelToSpherePos(atlasUv, face, ci, cj, pa);",
    "  vec4 st = fetchCell(face, ci, cj);",
    "  float ha = st.r;",
    "  bool ocean = st.a > 0.5;",
    "  if (ocean){ fragColor = st; return; } /* ocean fixed Dirichlet */",
    "",
    "  float talus = max(uTalusAngle, 1e-9);",
    "  float thermal_d = max(uThermalD, 0.0);",
    "  float w_cap = CFL_SUM / MAX_DEGREE; /* 0.125 */",
    "  bool a_corner = isCorner(ci, cj);",
    "  float a_cs = a_corner ? cornerSlopeAt(face, ci, cj) : -1.0;",
    "",
    "  int nf[4]; int ni[4]; int nj[4];",
    "  int cnt = gatherNeighbours(face, ci, cj, nf, ni, nj);",
    "  float delta = 0.0;",
    "  for (int k = 0; k < 4; k++){",
    "    if (k >= cnt) break;",
    "    if (isOceanCell(nf[k], ni[k], nj[k])) continue; /* land-land only */",
    "    vec3 pb = cellPos(nf[k], ni[k], nj[k]);",
    "    float dist = greatCircle(pa, pb);",
    "    if (dist <= 1e-9) continue;",
    "    float hb = fetchH(nf[k], ni[k], nj[k]);",
    "    float dh = hb - ha; /* OLD field (this cell is 'a'). */",
    "    bool b_corner = isCorner(ni[k], nj[k]);",
    "    float s;",
    "    if (a_corner || b_corner){",
    "      float cs = a_corner ? a_cs : cornerSlopeAt(nf[k], ni[k], nj[k]);",
    "      if ((cs == cs) && abs(cs) < 3.4028235e38 && cs > 0.0) s = cs;",
    "      else s = max(abs(dh) / dist, 0.0);",
    "    } else {",
    "      s = max(abs(dh) / dist, 0.0);",
    "    }",
    "    if (s < talus) continue;             /* gentle: no creep */",
    "    float d_eff = thermal_d * (1.0 - talus / s);",
    "    if (d_eff <= 0.0) continue;",
    "    float w = min(d_eff, w_cap);",
    "    float flux = w * dh;                 /* a -> b when h_b > h_a */",
    "    if (!(flux == flux) || abs(flux) >= 3.4028235e38) continue;",
    "    delta += flux; /* this cell is endpoint 'a': delta[a] += flux */",
    "  }",
    "  fragColor = vec4(ha + delta, st.g, st.b, st.a);",
    "}",
  ].join("\n");

/* ===================================================================
 *  PASS 4 — UPSAMPLE_FRAG  (port of upsample2x + PD pit-fill, A9)
 *
 *  Three sub-stages in the MANDATORY Rust order, split across modes the
 *  A15 orchestrator selects via uUpsampleMode (a single fragment cannot
 *  do an unbounded PD sweep — see fillPits):
 *    mode 0: bilinear h (sphere round-trip -> coarse face -> 4-tap on
 *            the COARSE atlas via tap2D). Writes h to .r; copies the
 *            slope/aux through. (Rust step 1.)
 *    mode 1: ONE PD pit-fill relaxation step on the fine h (fillPits;
 *            run N bounded times by A15). (Rust step 2 — the unbounded
 *            sweep loop, decomposed into bounded ping-pong passes.)
 *    mode 2: exact area-weighted water/sed split + ocean from post-fill
 *            h (Rust step 3): child0..2 = parent*area/Sum, child3 =
 *            parent - (c0+c1+c2) (exact remainder => Sum4==parent).
 *  uState in mode 0 = the COARSE field; uFaceRes = the FINE res; the
 *  coarse res is uCoarseFaceRes. Order is enforced by the orchestrator:
 *  upsample h -> pit-fill h -> apply conserved water/sed.
 * =================================================================== */
export const UPSAMPLE_FRAG: string =
  GLSL_PRELUDE +
  GLSL_FILLPITS +
  [
    "uniform vec2 uResolution;",
    "uniform int  uUpsampleMode;     /* 0=bilinear h, 1=pit-fill, 2=w/sed. */",
    "uniform float uCoarseFaceRes;   /* coarse n (mode 0 & 2 source res). */",
    "uniform sampler2D uCoarse;      /* coarse atlas (mode 0 & 2 source). */",
    "uniform vec2 uCoarseTexel;      /* 1/size of the coarse atlas. */",
    "",
    "/* coarse face (u,v) -> coarse-atlas UV (3x2 tiling at coarse res). */",
    "vec2 coarseFaceUvToAtlasUv(int face, float fu, float fv){",
    "  float tileX = float(face - 3 * (face / 3));",
    "  float tileY = float(face / 3);",
    "  return vec2((tileX + fu) / ATLAS_COLS, (tileY + fv) / ATLAS_ROWS);",
    "}",
    "vec4 coarseCell(int face, int i, int j){",
    "  float n = uCoarseFaceRes;",
    "  float fu = (float(i)+0.5)/n; float fv = (float(j)+0.5)/n;",
    "  return texture(uCoarse, coarseFaceUvToAtlasUv(face, fu, fv));",
    "}",
    "",
    "void main(){",
    "  vec2 atlasUv = gl_FragCoord.xy / uResolution;",
    "  int face, fi, fj; vec3 p;",
    "  faceTexelToSpherePos(atlasUv, face, fi, fj, p);",
    "",
    "  if (uUpsampleMode == 0){",
    "    /* --- Rust step 1: bilinear h, seam-correct. --- */",
    "    int cf; float cu; float cv;",
    "    sphereToFaceUv(p, cf, cu, cv);",
    "    float nc = uCoarseFaceRes;",
    "    float fx = clamp(cu * nc - 0.5, 0.0, nc - 1.0);",
    "    float fy = clamp(cv * nc - 0.5, 0.0, nc - 1.0);",
    "    int i0 = int(floor(fx));",
    "    int j0 = int(floor(fy));",
    "    int i1 = min(i0 + 1, int(nc) - 1);",
    "    int j1 = min(j0 + 1, int(nc) - 1);",
    "    float tx = fx - float(i0);",
    "    float ty = fy - float(j0);",
    "    float h00 = coarseCell(cf, i0, j0).r;",
    "    float h10 = coarseCell(cf, i1, j0).r;",
    "    float h01 = coarseCell(cf, i0, j1).r;",
    "    float h11 = coarseCell(cf, i1, j1).r;",
    "    float a = h00 + (h10 - h00) * tx;",
    "    float b = h01 + (h11 - h01) * tx;",
    "    float hf = a + (b - a) * ty;",
    "    /* slope01 (.g) is recomputed by the orchestrator post-upsample;",
    "       carry coarse .g/.b through; ocean (.a) set from post-fill h",
    "       in mode 2 (Rust sets ocean AFTER the fill). Provisional here. */",
    "    vec4 cc = coarseCell(cf, i0, j0);",
    "    fragColor = vec4(hf, cc.g, cc.b, hf < 0.0 ? 1.0 : 0.0);",
    "    return;",
    "  }",
    "",
    "  if (uUpsampleMode == 1){",
    "    /* --- Rust step 2: ONE PD pit-fill relaxation step. --- */",
    "    float hk = fetchH(face, fi, fj); /* fine post-bilinear h. */",
    "    float wv = fillPits(face, fi, fj, hk);",
    "    vec4 st = fetchCell(face, fi, fj);",
    "    fragColor = vec4(wv, st.g, st.b, st.a);",
    "    return;",
    "  }",
    "",
    "  /* --- Rust step 3: exact area-weighted water/sed split. --- */",
    "  /* This FINE child (fi,fj) belongs to coarse parent (fi/2, fj/2)",
    "     on the SAME face (1:4, no seam). child = parent*area/Sum, with",
    "     the 4th child taking the exact remainder so Sum4==parent. */",
    "  int pi = fi / 2;",
    "  int pj = fj / 2;",
    "  int baseI = pi * 2;",
    "  int baseJ = pj * 2;",
    "  ivec2 offs[4] = ivec2[4](ivec2(0,0), ivec2(1,0), ivec2(0,1), ivec2(1,1));",
    "  float area[4];",
    "  float area_sum = 0.0;",
    "  int myChild = -1;",
    "  for (int c = 0; c < 4; c++){",
    "    int cfi = baseI + offs[c].x;",
    "    int cfj = baseJ + offs[c].y;",
    "    float aa = cellSolidAngle(face, cfi, cfj);",
    "    area[c] = aa;",
    "    area_sum += aa;",
    "    if (cfi == fi && cfj == fj) myChild = c;",
    "  }",
    "  vec4 pc = coarseCell(face, pi, pj); /* parent coarse cell. */",
    "  float wp = pc.g; /* parent water (carried in .g of coarse field). */",
    "  float sp = pc.b; /* parent sed   (carried in .b). */",
    "  float hf = fetchH(face, fi, fj);   /* post-fill fine h. */",
    "  float outW; float outS;",
    "  if (area_sum > 0.0){",
    "    if (myChild < 3){",
    "      float frac = area[myChild] / area_sum;",
    "      outW = wp * frac;",
    "      outS = sp * frac;",
    "    } else {",
    "      /* 4th child: exact remainder parent - (c0+c1+c2). */",
    "      float acc_w = 0.0; float acc_s = 0.0;",
    "      for (int c = 0; c < 3; c++){",
    "        float frac = area[c] / area_sum;",
    "        acc_w += wp * frac;",
    "        acc_s += sp * frac;",
    "      }",
    "      outW = wp - acc_w;",
    "      outS = sp - acc_s;",
    "    }",
    "  } else {",
    "    float qw = wp * 0.25; float qs = sp * 0.25;",
    "    if (myChild < 3){ outW = qw; outS = qs; }",
    "    else { outW = wp - qw * 3.0; outS = sp - qs * 3.0; }",
    "  }",
    "  fragColor = vec4(hf, outW, outS, hf < 0.0 ? 1.0 : 0.0);",
    "}",
  ].join("\n");

/* ===================================================================
 *  PASS 5 — RESAMPLE_FRAG  (port of cubesphere_to_equirect, A11)
 *
 *  Render target = the equirect raster (w x h). Per equirect texel:
 *   v = (y+0.5)/h ; phi = PI/2 - v*PI
 *   u = (x+0.5)/w ; lambda = u*2PI - PI
 *   pos = (cos phi*cos lambda, sin phi, cos phi*sin lambda)  [Y-up]
 *   (face,fu,fv) = sphere_to_face_uv(pos)
 *   h = bilinear_face(face, fu, fv)  -- clamped to the face interior,
 *       via tap2D over the cube atlas (4-tap when uManualBilinear).
 *  U-wrap is exact by construction (lon=-PI and +PI are the same
 *  meridian); V is clamped at the poles (the bilinear_face clamp).
 * =================================================================== */
export const RESAMPLE_FRAG: string =
  GLSL_PRELUDE +
  [
    "uniform vec2 uEquirectSize; /* (w, h) of the equirect target. */",
    "",
    "/* bilinear_face — resample.rs bilinear_face: clamp UV to the face",
    "   interior (texel centres at (i+0.5)/n), 4-tap inside that face.",
    "   Done through tap2D on the atlas so the manual-bilinear fallback",
    "   path applies; taps are clamped to the face's own tile so a fetch",
    "   never crosses a cube seam (the only continuity need is the lon",
    "   wrap, exact by construction). */",
    "float bilinearFace(int face, float fu, float fv){",
    "  float nf = uFaceRes;",
    "  if (nf <= 0.0) return 0.0;",
    "  float su = clamp(clamp(fu, 0.0, 1.0) * nf - 0.5, 0.0, nf - 1.0);",
    "  float sv = clamp(clamp(fv, 0.0, 1.0) * nf - 0.5, 0.0, nf - 1.0);",
    "  int i0 = int(floor(su));",
    "  int j0 = int(floor(sv));",
    "  int i1 = min(i0 + 1, int(nf) - 1);",
    "  int j1 = min(j0 + 1, int(nf) - 1);",
    "  float tu = su - float(i0);",
    "  float tv = sv - float(j0);",
    "  float h00 = fetchH(face, i0, j0);",
    "  float h10 = fetchH(face, i1, j0);",
    "  float h01 = fetchH(face, i0, j1);",
    "  float h11 = fetchH(face, i1, j1);",
    "  float a = h00 + (h10 - h00) * tu;",
    "  float b = h01 + (h11 - h01) * tu;",
    "  return a + (b - a) * tv;",
    "}",
    "",
    "void main(){",
    "  /* equirect pixel coords from the render-target fragment. */",
    "  float px = gl_FragCoord.x;",
    "  float py = gl_FragCoord.y;",
    "  float w = uEquirectSize.x;",
    "  float hgt = uEquirectSize.y;",
    "  /* Rust: y=0 is the NORTH pole (top row). gl_FragCoord.y is",
    "     bottom-origin, so flip to row index yRow with yRow=0 at top. */",
    "  float yRow = hgt - py; /* fragment centre is at +0.5 already. */",
    "  float v = yRow / hgt;",
    "  float phi = (PI / 2.0) - v * PI;",
    "  float sphi = sin(phi);",
    "  float cphi = cos(phi);",
    "  float u = px / w;",
    "  float lambda = u * 2.0 * PI - PI;",
    "  float slam = sin(lambda);",
    "  float clam = cos(lambda);",
    "  vec3 pos = vec3(cphi * clam, sphi, cphi * slam); /* Y-up. */",
    "  int face; float fu; float fv;",
    "  sphereToFaceUv(pos, face, fu, fv);",
    "  float hOut = bilinearFace(face, fu, fv);",
    "  /* tap2D referenced so the manual-bilinear path is wired in even",
    "     though bilinearFace does the face-clamped 4-tap explicitly via",
    "     fetchH; this keeps the uManualBilinear contract uniform. */",
    "  if (uManualBilinear == 99){ hOut += tap2D(uState, vec2(0.0), uAtlasTexel).r; }",
    "  fragColor = vec4(hOut, 0.0, 0.0, hOut < 0.0 ? 1.0 : 0.0);",
    "}",
  ].join("\n");
