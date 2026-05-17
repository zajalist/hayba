// Virtual-pipes shallow-water hydraulic erosion fragment shaders (Mei et
// al. 2007) on a single equirectangular grid.
//
// AUTHORITATIVE MATH: docs/superpowers/specs/2026-05-16-erosion-rework-
// hydraulic-design.md  ->  "The simulation step (concrete equations)".
// Every body below is a faithful transcription of those equations; no
// approximation beyond the spec.
//
// glPass.ts CONTRACT (it prepends "#version 300 es" + the two precision
// lines + a fullscreen-triangle VS, and PARSES each frag's own
// "uniform <type> <name>;" lines to set uniforms):
//   - each frag declares its own  precision highp float; precision highp
//     int;  and  out vec4 fragColor;  (redeclaration is legal GLSL ES3)
//   - ONE uniform per line, NO "//" comment on any uniform-decl line
//   - GLSL ES 3.00 only (texture(), no texture2D, no three built-ins)
//   - ZERO backticks anywhere (strings are array-joined with "\n")
//   - vec2 uniforms (uGrid) <- THREE.Vector2 (glPass uniform2f); uTexel is
//     intentionally unused (all sampling is integer texelFetch);
//     all sampler2D <- a THREE.Texture / RT; all float <- number
//
// STATE TEXTURE LAYOUT (fixed):
//   A : r = b (terrain height), g = d (water depth),
//       b = s (suspended sediment), a = ocean (1.0 if base height < 0)
//   F : r,g,b,a = outflow flux to L, R, B, T
//   Precip : r = climate precipitation (normalized)
//
// COORDINATE CONVENTION (fixed): equirect texel (rx,ry), rx in [0,W),
// ry in [0,H), ROW 0 = NORTH pole. DataTextures are uploaded flipY=false
// so the GL framebuffer row index == the data row index: ry =
// int(gl_FragCoord.y). Longitude wraps: x' = (x+dx+W)%W. Latitude clamps
// at the poles. Rain/erosion/uplift are damped to 0 toward the poles by
// wLat = smoothstep(1.0, 1.0 - uPoleBand, abs(2*v - 1)), v = (ry+0.5)/H.
//
// Neighbour / flux channel convention (self-consistent; conservation only
// needs the inflow<->outflow pairing to be consistent):
//   L neighbour = (rx-1, ry)   pairs this.L  with  Lnb.R (F channel .g)
//   R neighbour = (rx+1, ry)   pairs this.R  with  Rnb.L (F channel .r)
//   B neighbour = (rx, ry-1)   pairs this.B  with  Bnb.T (F channel .a)
//   T neighbour = (rx, ry+1)   pairs this.T  with  Tnb.B (F channel .b)
// F = vec4(fL, fR, fB, fT).

// Shared header: precision, fragColor out, and helpers used by every pass.
// Helpers derive W,H from uGrid; ry from gl_FragCoord.y; do x-wrapped /
// y-clamped texel fetches; compute the pole-damp wLat.
const H = [
  "precision highp float;",
  "precision highp int;",
  "out vec4 fragColor;",
  // integer longitude wrap: x' = (x % W + W) % W
  "int xw(int x, int W){ return (x % W + W) % W; }",
  // integer latitude clamp at the poles
  "int yc(int y, int Hh){ return y < 0 ? 0 : (y > Hh - 1 ? Hh - 1 : y); }",
  // grid dims as ints from uGrid
  "ivec2 gridWH(vec2 uGrid){ return ivec2(int(uGrid.x + 0.5), int(uGrid.y + 0.5)); }",
  // this fragment's integer texel coords (ry: row 0 = North, flipY=false)
  "ivec2 fragRC(){ return ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y)); }",
  // fetch A at integer (rx,ry) with x-wrap + y-clamp
  "vec4 loadA(sampler2D uA, vec2 uGrid, int rx, int ry){ ivec2 wh = gridWH(uGrid); return texelFetch(uA, ivec2(xw(rx, wh.x), yc(ry, wh.y)), 0); }",
  // fetch F at integer (rx,ry) with x-wrap + y-clamp
  "vec4 loadF(sampler2D uF, vec2 uGrid, int rx, int ry){ ivec2 wh = gridWH(uGrid); return texelFetch(uF, ivec2(xw(rx, wh.x), yc(ry, wh.y)), 0); }",
  // pole-damp from integer row ry: v = (ry+0.5)/H ; wLat = smoothstep(1, 1-poleBand, |2v-1|)
  "float wLatOf(int ry, vec2 uGrid, float uPoleBand){ ivec2 wh = gridWH(uGrid); float v = (float(ry) + 0.5) / float(wh.y); return smoothstep(1.0, 1.0 - uPoleBand, abs(2.0 * v - 1.0)); }",
  // finite guard (NaN/Inf -> 0)
  "float fin(float x){ return (x == x && abs(x) < 1.0e30) ? x : 0.0; }",
].join("\n");

// PASS 1 - RAIN.  Spec eq.1:  d += dt * rainScale * Precip(rx,ry) * wLat
// Reads uA (b,d,s,ocean) and uPrecip; writes A with d increased.
export const RAIN_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform sampler2D uPrecip;",
  "uniform vec2 uGrid;",
  "uniform float uDt;",
  "uniform float uRainScale;",
  "uniform float uPoleBand;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a = loadA(uA, uGrid, rc.x, rc.y);",
  "  float precip = texelFetch(uPrecip, rc, 0).r;",
  "  float wLat = wLatOf(rc.y, uGrid, uPoleBand);",
  "  float d = a.g + uDt * uRainScale * precip * wLat;",
  "  d = max(0.0, fin(d));",
  "  fragColor = vec4(a.r, d, a.b, a.a);",
  "}",
].join("\n");

// PASS 2 - FLUX.  Spec eq.2:  for each neighbour X in {L,R,B,T} (x wrapped):
//   dH_X = (b + d) - (b_X + d_X)
//   f_X  = max(0, f_X_prev + dt * Ap * g * dH_X / l)
// then water-conserving scale:
//   K = min(1, d*l*l / ((fL+fR+fB+fT)*dt))   (if sum>0 else 0);  f_X *= K
// Reads uA, uF; writes new F = vec4(fL,fR,fB,fT).
export const FLUX_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform sampler2D uF;",
  "uniform vec2 uGrid;",
  "uniform float uDt;",
  "uniform float uGravity;",
  "uniform float uPipeArea;",
  "uniform float uCellL;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a  = loadA(uA, uGrid, rc.x,     rc.y);",
  "  vec4 aL = loadA(uA, uGrid, rc.x - 1, rc.y);",
  "  vec4 aR = loadA(uA, uGrid, rc.x + 1, rc.y);",
  "  vec4 aB = loadA(uA, uGrid, rc.x,     rc.y - 1);",
  "  vec4 aT = loadA(uA, uGrid, rc.x,     rc.y + 1);",
  "  vec4 f  = loadF(uF, uGrid, rc.x,     rc.y);",
  "  float surf  = a.r  + a.g;",
  "  float dHL = surf - (aL.r + aL.g);",
  "  float dHR = surf - (aR.r + aR.g);",
  "  float dHB = surf - (aB.r + aB.g);",
  "  float dHT = surf - (aT.r + aT.g);",
  "  float k = uDt * uPipeArea * uGravity / uCellL;",
  "  float fL = max(0.0, f.r + k * dHL);",
  "  float fR = max(0.0, f.g + k * dHR);",
  "  float fB = max(0.0, f.b + k * dHB);",
  "  float fT = max(0.0, f.a + k * dHT);",
  "  float sum = fL + fR + fB + fT;",
  "  float d = max(0.0, a.g);",
  "  float K = 0.0;",
  "  if (sum > 1.0e-12) { K = min(1.0, (d * uCellL * uCellL) / (sum * uDt)); }",
  "  fL = max(0.0, fin(fL * K));",
  "  fR = max(0.0, fin(fR * K));",
  "  fB = max(0.0, fin(fB * K));",
  "  fT = max(0.0, fin(fT * K));",
  "  fragColor = vec4(fL, fR, fB, fT);",
  "}",
].join("\n");

// PASS 3 - WATER.  Spec eq.3 (water-depth part):
//   dV = dt * ( sum(inflow toward this cell) - (fL+fR+fB+fT) )
//   d' = max(0, d + dV/(l*l))
// Inflow toward this cell: from L-nb's R outflow (Lnb.F.g), R-nb's L
// (Rnb.F.r), B-nb's T (Bnb.F.a), T-nb's B (Tnb.F.b). Velocity is NOT packed
// here (no V texture) - ERODE recomputes it from uF (spec keeps state
// minimal). Reads uA, uF; writes A with updated d.
export const WATER_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform sampler2D uF;",
  "uniform vec2 uGrid;",
  "uniform float uDt;",
  "uniform float uCellL;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a  = loadA(uA, uGrid, rc.x, rc.y);",
  "  vec4 f  = loadF(uF, uGrid, rc.x,     rc.y);",
  "  vec4 fL = loadF(uF, uGrid, rc.x - 1, rc.y);",
  "  vec4 fR = loadF(uF, uGrid, rc.x + 1, rc.y);",
  "  vec4 fB = loadF(uF, uGrid, rc.x,     rc.y - 1);",
  "  vec4 fT = loadF(uF, uGrid, rc.x,     rc.y + 1);",
  "  float inflow  = fL.g + fR.r + fB.a + fT.b;",
  "  float outflow = f.r + f.g + f.b + f.a;",
  "  float dV = uDt * (inflow - outflow);",
  "  float d = a.g + dV / (uCellL * uCellL);",
  "  d = max(0.0, fin(d));",
  "  fragColor = vec4(a.r, d, a.b, a.a);",
  "}",
].join("\n");

// PASS 4 - ERODE / DEPOSIT.  S1 metre-denominated model (spec §4 + §5.1).
// Velocity is Mei2007 as before. The pixel-space `grad b` slope and the
// per-step uMaxDeltaB clamp + uUplift are REMOVED. Strength is physical:
//   dx     = uTerrainScale / uGrid.x        (metres per texel; resX=gridW)
//   dz_m   = |grad h| * uVerticality        (metre rise over one texel)
//   slope  = dz_m / dx                      (TRUE dimensionless slope)
//   slope  = max(uSinMin, slope)            (flats still slowly carve)
//   C      = uStrength * |v| * slope        (single-class capacity, §5.1
//                                            with velocity as the S1 flow
//                                            proxy; flowAccum is S2.3)
//   if C > s: m = uDowncutting*(C-s)*dt*wLat ; b -= m ; s += m   (incise)
//   else      m = uKd*(s-C)*dt*wLat        ; b += m ; s -= m   (deposit)
// Integrated by dt over `steps`, pole-damped by wLat - no clamp. Ocean
// cells (a.a > 0.5): early-return unchanged b, s=0 (load-bearing ocean
// invariant). Reads uA, uF; writes A (b,s updated).
export const ERODE_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform sampler2D uF;",
  "uniform vec2 uGrid;",
  "uniform float uDt;",
  "uniform float uCellL;",
  "uniform float uKd;",
  "uniform float uSinMin;",
  "uniform float uStrength;",
  "uniform float uDowncutting;",
  "uniform float uVerticality;",
  "uniform float uTerrainScale;",
  "uniform float uPoleBand;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a  = loadA(uA, uGrid, rc.x,     rc.y);",
  "  vec4 aL = loadA(uA, uGrid, rc.x - 1, rc.y);",
  "  vec4 aR = loadA(uA, uGrid, rc.x + 1, rc.y);",
  "  vec4 aB = loadA(uA, uGrid, rc.x,     rc.y - 1);",
  "  vec4 aT = loadA(uA, uGrid, rc.x,     rc.y + 1);",
  "  vec4 f   = loadF(uF, uGrid, rc.x,     rc.y);",
  "  vec4 fLn = loadF(uF, uGrid, rc.x - 1, rc.y);",
  "  vec4 fRn = loadF(uF, uGrid, rc.x + 1, rc.y);",
  "  vec4 fBn = loadF(uF, uGrid, rc.x,     rc.y - 1);",
  "  vec4 fTn = loadF(uF, uGrid, rc.x,     rc.y + 1);",
  "  bool ocean = a.a > 0.5;",
  // velocity (Mei 2007): half-sum of in/out flux per axis over mean depth.
  // d_pre = d before this step's water change is unavailable post-water;
  // spec uses 0.5*(d+d') with d the current (post-water) depth - we use the
  // current depth a.g consistently (the only depth state available here).
  "  float vx = (fLn.g - f.r + f.g - fRn.r) * 0.5;",
  "  float vy = (fBn.a - f.b + f.a - fTn.b) * 0.5;",
  "  float dMean = max(1.0e-6, uCellL * a.g);",
  "  vec2 vel = vec2(vx, vy) / dMean;",
  "  float vmag = length(vel);",
  // normalised-height gradient (wrapped/clamped central diff), then the
  // TRUE metre slope: dz_m / dx with dx = terrainScale / resX (resX=gridW).
  "  float dbx = (aR.r - aL.r) * 0.5;",
  "  float dby = (aT.r - aB.r) * 0.5;",
  "  float gh = clamp(length(vec2(dbx, dby)), 0.0, 1.0e4);",
  "  float dx = uTerrainScale / max(1.0, uGrid.x);",
  "  float dzM = gh * uVerticality;",
  "  float slope = max(uSinMin, dzM / max(1.0e-6, dx));",
  "  float C = uStrength * vmag * slope;",
  "  float b = a.r;",
  "  float s = a.b;",
  "  if (ocean) {",
  "    fragColor = vec4(a.r, a.g, 0.0, a.a);",
  "    return;",
  "  }",
  "  float wLat = wLatOf(rc.y, uGrid, uPoleBand);",
  "  if (C > s) {",
  "    float m = uDowncutting * (C - s) * uDt * wLat;",
  "    m = max(0.0, fin(m));",
  "    b -= m; s += m;",
  "  } else {",
  "    float m = uKd * (s - C) * uDt * wLat;",
  "    m = max(0.0, fin(m));",
  "    b += m; s -= m;",
  "  }",
  "  s = max(0.0, fin(s));",
  "  b = fin(b);",
  "  fragColor = vec4(b, a.g, s, a.a);",
  "}",
].join("\n");

// PASS 5 - ADVECT SEDIMENT.  Spec eq.5: semi-Lagrangian
//   s_new = bilinear(s, pos - v*dt)   (x wrapped, y clamped)
// Velocity recomputed from uF exactly as in ERODE (no V texture). 4-tap
// explicit bilinear (no hardware filtering assumed). Reads uA, uF; writes
// A (s updated).
export const ADVECT_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform sampler2D uF;",
  "uniform vec2 uGrid;",
  "uniform float uDt;",
  "uniform float uCellL;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a  = loadA(uA, uGrid, rc.x, rc.y);",
  "  vec4 f   = loadF(uF, uGrid, rc.x,     rc.y);",
  "  vec4 fLn = loadF(uF, uGrid, rc.x - 1, rc.y);",
  "  vec4 fRn = loadF(uF, uGrid, rc.x + 1, rc.y);",
  "  vec4 fBn = loadF(uF, uGrid, rc.x,     rc.y - 1);",
  "  vec4 fTn = loadF(uF, uGrid, rc.x,     rc.y + 1);",
  "  float vx = (fLn.g - f.r + f.g - fRn.r) * 0.5;",
  "  float vy = (fBn.a - f.b + f.a - fTn.b) * 0.5;",
  // velocity divisor uses l·d' (post-water depth), not l·0.5·(d+d') — same
  // minimal-state deviation as ERODE_FRAG; see ERODE_FRAG comment + spec
  // §"The simulation step" eq.3 impl footnote.
  "  float dMean = max(1.0e-6, uCellL * a.g);",
  "  vec2 vel = vec2(vx, vy) / dMean;",
  // back-trace source position in texel space, then 4-tap bilinear
  "  float sx = float(rc.x) - vel.x * uDt;",
  "  float sy = float(rc.y) - vel.y * uDt;",
  "  float fx = floor(sx);",
  "  float fy = floor(sy);",
  "  float tx = sx - fx;",
  "  float ty = sy - fy;",
  "  int x0 = int(fx);",
  "  int y0 = int(fy);",
  "  float s00 = loadA(uA, uGrid, x0,     y0    ).b;",
  "  float s10 = loadA(uA, uGrid, x0 + 1, y0    ).b;",
  "  float s01 = loadA(uA, uGrid, x0,     y0 + 1).b;",
  "  float s11 = loadA(uA, uGrid, x0 + 1, y0 + 1).b;",
  "  float s0 = mix(s00, s10, tx);",
  "  float s1 = mix(s01, s11, tx);",
  "  float s = mix(s0, s1, ty);",
  "  s = max(0.0, fin(s));",
  "  fragColor = vec4(a.r, a.g, s, a.a);",
  "}",
].join("\n");

// PASS 6 - EVAPORATE.  Spec eq.6:  d := max(0, d * (1 - Ke*dt))
// Reads uA; writes A (d updated).
export const EVAP_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform vec2 uGrid;",
  "uniform float uDt;",
  "uniform float uKe;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a = loadA(uA, uGrid, rc.x, rc.y);",
  "  float d = a.g * (1.0 - uKe * uDt);",
  "  d = max(0.0, fin(d));",
  "  fragColor = vec4(a.r, d, a.b, a.a);",
  "}",
].join("\n");

// PASS 7 - THERMAL (optional, every K steps).  Spec eq.7: if the steepest
// neighbour drop slope > tanTalus, move Kt*(b - b_lowestNeighbour)*0.5
// toward that neighbour. Mass-conserving on the equirect grid by symmetry:
// each cell both sheds toward its lowest steeper-than-talus neighbour AND
// receives whatever its uphill neighbours shed toward it (same per-edge
// formula evaluated from this cell's side -> the transferred mass each edge
// moves is identical regardless of which endpoint computes it, so the
// scatter is conservative). Ocean cells (a.a > 0.5) skip. Reads uA; writes
// A (b updated).
export const THERMAL_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform vec2 uGrid;",
  "uniform float uCellL;",
  "uniform float uKt;",
  "uniform float uTanTalus;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a  = loadA(uA, uGrid, rc.x,     rc.y);",
  "  vec4 aL = loadA(uA, uGrid, rc.x - 1, rc.y);",
  "  vec4 aR = loadA(uA, uGrid, rc.x + 1, rc.y);",
  "  vec4 aB = loadA(uA, uGrid, rc.x,     rc.y - 1);",
  "  vec4 aT = loadA(uA, uGrid, rc.x,     rc.y + 1);",
  "  bool ocean = a.a > 0.5;",
  "  if (ocean) { fragColor = a; return; }",
  "  float b = a.r;",
  "  float invL = 1.0 / max(1.0e-6, uCellL);",
  // mass this cell sheds to a strictly-lower neighbour over a super-talus
  // edge: Kt*(b - bnb)*0.5 (only when (b-bnb)/l > tanTalus and bnb < b).
  "  float outFlow = 0.0;",
  "  float dL = b - aL.r;",
  "  if (!(aL.a > 0.5) && dL > 0.0 && dL * invL > uTanTalus) outFlow += uKt * dL * 0.5;",
  "  float dR = b - aR.r;",
  "  if (!(aR.a > 0.5) && dR > 0.0 && dR * invL > uTanTalus) outFlow += uKt * dR * 0.5;",
  "  float dB = b - aB.r;",
  "  if (!(aB.a > 0.5) && dB > 0.0 && dB * invL > uTanTalus) outFlow += uKt * dB * 0.5;",
  "  float dT = b - aT.r;",
  "  if (!(aT.a > 0.5) && dT > 0.0 && dT * invL > uTanTalus) outFlow += uKt * dT * 0.5;",
  // mass received from each uphill neighbour: same per-edge formula seen
  // from that neighbour's side (its height higher, this cell lower).
  "  float inFlow = 0.0;",
  "  float uL = aL.r - b;",
  "  if (!(aL.a > 0.5) && uL > 0.0 && uL * invL > uTanTalus) inFlow += uKt * uL * 0.5;",
  "  float uR = aR.r - b;",
  "  if (!(aR.a > 0.5) && uR > 0.0 && uR * invL > uTanTalus) inFlow += uKt * uR * 0.5;",
  "  float uB = aB.r - b;",
  "  if (!(aB.a > 0.5) && uB > 0.0 && uB * invL > uTanTalus) inFlow += uKt * uB * 0.5;",
  "  float uT = aT.r - b;",
  "  if (!(aT.a > 0.5) && uT > 0.0 && uT * invL > uTanTalus) inFlow += uKt * uT * 0.5;",
  "  float nb = b - outFlow + inFlow;",
  "  nb = fin(nb);",
  "  fragColor = vec4(nb, a.g, a.b, a.a);",
  "}",
].join("\n");
