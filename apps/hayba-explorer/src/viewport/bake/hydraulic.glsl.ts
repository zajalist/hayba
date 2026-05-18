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
  // Resolution invariance: virtual-pipe flux (hence `vmag`) ∝ per-texel
  // Δ(b+d), so erosion measured ∝ W^-0.89 (same-input oracle study). S1
  // already made `slope` W-invariant; this is the flux-side counterpart.
  // uResScale = (W/REF)^0.89 restores capacity to the calibration res.
  "uniform float uResScale;",
  // R2: SFD drainage discharge drives the DOMINANT incision term.
  // Capacity is multiplied by Q^uSpM so high-discharge channels incise
  // hard while low-Q interfluves fall to the deposition branch and stand
  // as ridges -> dendritic. Q is the SFD ACC field (W-stable, #218 R1b).
  "uniform sampler2D uAcc;",
  "uniform float uAccResScale;",
  "uniform float uSpM;",
  "uniform sampler2D uDetailMask;",
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
  // vmag*uResScale = resolution-invariant velocity (see uResScale comment).
  "  float Q = loadF(uAcc, uGrid, rc.x, rc.y).r * uAccResScale;",
  "  float C = uStrength * (vmag * uResScale) * slope * pow(max(Q, 0.0), uSpM);",
  "  float b = a.r;",
  "  float s = a.b;",
  "  if (ocean) {",
  "    fragColor = vec4(a.r, a.g, 0.0, a.a);",
  "    return;",
  "  }",
  "  float wLat = wLatOf(rc.y, uGrid, uPoleBand);",
  // S2.4: gate INCISION by the detail mask (strong on steep/high terrain,
  // ~0 on ocean & flatland). Deposition is left ungated so sediment still
  // settles naturally in lowlands/valleys.
  "  float dm = loadA(uDetailMask, uGrid, rc.x, rc.y).r;",
  "  if (C > s) {",
  "    float m = uDowncutting * (C - s) * uDt * wLat * dm;",
  "    m = max(0.0, fin(m));",
  "    b -= m; s += m;",
  "  } else {",
  "    float m = uKd * (s - C) * uDt * wLat;",
  "    m = max(0.0, fin(m));",
  "    b += m; s -= m;",
  "  }",
  "  s = max(0.0, fin(s));",
  "  b = fin(b);",
  // STABILITY (base-level clamp, mirrors CARVE_RIVERS): incision may not
  // gouge below the lowest LAND neighbour (a hair lower for the channel
  // floor). ERODE capacity is unbounded, so without this the uResScale
  // boost at very high W lets an isolated high-flux cell over-incise far
  // below base level (minB ≪ -1 spike). In a real valley the downstream
  // neighbour is also carving, so the whole profile still lowers —
  // dendritic incision preserved, runaway pit removed. (ocean already
  // early-returned above, so these neighbour reads are land-or-ocean.)
  "  float minNb = a.r;",
  "  if (!(aL.a > 0.5)) minNb = min(minNb, aL.r);",
  "  if (!(aR.a > 0.5)) minNb = min(minNb, aR.r);",
  "  if (!(aB.a > 0.5)) minNb = min(minNb, aB.r);",
  "  if (!(aT.a > 0.5)) minNb = min(minNb, aT.r);",
  "  b = fin(max(b, minNb - 1.0e-3));",
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
// S2.2 ANISOTROPIC THERMAL / TALUS — the ridgeline maker. 8-neighbour
// talus on a TRUE METRE slope (S1-consistent: slope =
// Δ(h*uVerticality)/(uTerrainScale/W); diagonals use sqrt2*dx). Per-edge
// transfer strength is direction-dependent: effStrength =
// uStrengthThermal * (1.0 + uAnisotropy*dirBias), dirBias = the edge
// direction projected on the local height gradient — settling biased
// along slope gives striated faces + sharp ridgelines, not smooth
// conical talus. Received inFlow scaled by (1-uSedimentRemoval) (lost to
// suspension); net pole-damped by wLat. Ocean (a.a > 0.5) skips
// byte-identically. Single-pass approximation: out/in use the LOCAL
// gradient so with anisotropy the scatter is approximately — not exactly
// — conservative; the per-cell net is HARD-CLAMPED to ±0.5× the local
// relief (explicit-talus CFL bound) so ANY strength/anisotropy/cadence is
// unconditionally stable (no overshoot/oscillation/blowup); fin()-guarded.
// Reads uA; writes A (b updated).
export const THERMAL_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform vec2 uGrid;",
  "uniform float uStrengthThermal;",
  "uniform float uTanTalus;",
  "uniform float uAnisotropy;",
  "uniform float uSedimentRemoval;",
  "uniform float uVerticality;",
  "uniform float uTerrainScale;",
  "uniform float uPoleBand;",
  "uniform sampler2D uDetailMask;",
  "/* One talus edge: this cell's shed (outFlow) toward a lower",
  "   super-talus neighbour + received (inFlow) from a higher one, with",
  "   the anisotropic direction-biased strength. Uniforms are GLSL",
  "   globals so the signature stays small. */",
  "void talusEdge(float b, vec4 anb, vec2 o, vec2 gN, float dm,",
  "               inout float outFlow, inout float inFlow,",
  "               inout float maxDown, inout float maxUp){",
  "  if (anb.a > 0.5) return;",
  "  float dnb = b - anb.r;",
  "  if (dnb > 0.0) maxDown = max(maxDown, dnb);",
  "  else           maxUp   = max(maxUp,  -dnb);",
  "  vec2 od = o / max(1.0e-6, length(o));",
  "  float dirBias = dot(od, gN);",
  "  float eff = uStrengthThermal * max(0.0, 1.0 + uAnisotropy * dirBias);",
  "  float dz = dnb * uVerticality;",
  "  if (dz > 0.0 && dz / dm > uTanTalus) {",
  "    outFlow += min(eff * dnb * 0.5, 0.45 * dnb);",
  "  }",
  "  float uz = -dz;",
  "  if (uz > 0.0 && uz / dm > uTanTalus) {",
  "    float unb = -dnb;",
  "    inFlow += min(eff * unb * 0.5, 0.45 * unb);",
  "  }",
  "}",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a  = loadA(uA, uGrid, rc.x,     rc.y);",
  "  bool ocean = a.a > 0.5;",
  "  if (ocean) { fragColor = a; return; }",
  "  vec4 aL  = loadA(uA, uGrid, rc.x - 1, rc.y);",
  "  vec4 aR  = loadA(uA, uGrid, rc.x + 1, rc.y);",
  "  vec4 aB  = loadA(uA, uGrid, rc.x,     rc.y - 1);",
  "  vec4 aT  = loadA(uA, uGrid, rc.x,     rc.y + 1);",
  "  vec4 aLB = loadA(uA, uGrid, rc.x - 1, rc.y - 1);",
  "  vec4 aRB = loadA(uA, uGrid, rc.x + 1, rc.y - 1);",
  "  vec4 aLT = loadA(uA, uGrid, rc.x - 1, rc.y + 1);",
  "  vec4 aRT = loadA(uA, uGrid, rc.x + 1, rc.y + 1);",
  "  float b = a.r;",
  "  ivec2 wh = gridWH(uGrid);",
  "  float dx = uTerrainScale / max(1.0, float(wh.x));",
  "  float sq2dx = 1.41421356 * dx;",
  "  vec2 g = vec2(aR.r - aL.r, aT.r - aB.r) * 0.5;",
  "  vec2 gN = normalize(g + vec2(1.0e-6));",
  "  float outFlow = 0.0;",
  "  float inFlow = 0.0;",
  "  float maxDown = 0.0;",
  "  float maxUp = 0.0;",
  "  talusEdge(b, aL , vec2(-1.0,  0.0), gN, dx,    outFlow, inFlow, maxDown, maxUp);",
  "  talusEdge(b, aR , vec2( 1.0,  0.0), gN, dx,    outFlow, inFlow, maxDown, maxUp);",
  "  talusEdge(b, aB , vec2( 0.0, -1.0), gN, dx,    outFlow, inFlow, maxDown, maxUp);",
  "  talusEdge(b, aT , vec2( 0.0,  1.0), gN, dx,    outFlow, inFlow, maxDown, maxUp);",
  "  talusEdge(b, aLB, vec2(-1.0, -1.0), gN, sq2dx, outFlow, inFlow, maxDown, maxUp);",
  "  talusEdge(b, aRB, vec2( 1.0, -1.0), gN, sq2dx, outFlow, inFlow, maxDown, maxUp);",
  "  talusEdge(b, aLT, vec2(-1.0,  1.0), gN, sq2dx, outFlow, inFlow, maxDown, maxUp);",
  "  talusEdge(b, aRT, vec2( 1.0,  1.0), gN, sq2dx, outFlow, inFlow, maxDown, maxUp);",
  "  float wLat = wLatOf(rc.y, uGrid, uPoleBand);",
  "  float dm = loadA(uDetailMask, uGrid, rc.x, rc.y).r;",
  "  float net = (inFlow * (1.0 - uSedimentRemoval) - outFlow) * wLat * dm;",
  // UNCONDITIONAL STABILITY (textbook explicit-talus CFL bound): a cell
  // may shed at most HALF the drop to its lowest land neighbour and gain
  // at most HALF the rise to its highest, per pass. This guarantees
  // monotone relaxation toward the talus equilibrium — no overshoot /
  // checkerboard oscillation / blowup — for ANY strength/anisotropy/
  // cadence (the prior aggressive tuning exploded without this). The
  // anisotropy still biases WHICH direction within the bound, so ridges
  // still form; they just cannot diverge.
  "  net = clamp(net, -0.5 * maxDown, 0.5 * maxUp);",
  "  float nb = fin(b + net);",
  "  fragColor = vec4(nb, a.g, a.b, a.a);",
  "}",
].join("\n");

// S2.4 DETAIL MASK (one-time, pre-loop). Gates ALL high-freq erosion/relief
// to steep, high terrain so the user's "mask at mountain heights; spare
// ocean & flatlands" holds: detail = elevGate * slopeGate, ocean -> 0.
// elevGate rises from uElevFloor*V to uElevMid*V metres; slopeGate from
// uSlopeFloor to uSlopeMid (true metre slope, S1-consistent). Reads the
// SEEDed A (b in .r, ocean in .a); writes the mask in .r (single channel).
// ERODE multiplies its incision by this; THERMAL multiplies its net move.
export const DETAIL_MASK_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform vec2 uGrid;",
  "uniform float uVerticality;",
  "uniform float uTerrainScale;",
  "uniform float uElevFloor;",
  "uniform float uElevMid;",
  "uniform float uSlopeFloor;",
  "uniform float uSlopeMid;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a  = loadA(uA, uGrid, rc.x,     rc.y);",
  "  if (a.a > 0.5) { fragColor = vec4(0.0); return; }",
  "  vec4 aL = loadA(uA, uGrid, rc.x - 1, rc.y);",
  "  vec4 aR = loadA(uA, uGrid, rc.x + 1, rc.y);",
  "  vec4 aB = loadA(uA, uGrid, rc.x,     rc.y - 1);",
  "  vec4 aT = loadA(uA, uGrid, rc.x,     rc.y + 1);",
  "  float zM = a.r * uVerticality;",
  "  float elevGate = smoothstep(uElevFloor * uVerticality, uElevMid * uVerticality, zM);",
  "  float dbx = (aR.r - aL.r) * 0.5;",
  "  float dby = (aT.r - aB.r) * 0.5;",
  "  float gh = clamp(length(vec2(dbx, dby)), 0.0, 1.0e4);",
  "  float dx = uTerrainScale / max(1.0, uGrid.x);",
  "  float slope = (gh * uVerticality) / max(1.0e-6, dx);",
  "  float slopeGate = smoothstep(uSlopeFloor, uSlopeMid, slope);",
  "  float m = clamp(elevGate * slopeGate, 0.0, 1.0);",
  "  fragColor = vec4(m, 0.0, 0.0, 1.0);",
  "}",
].join("\n");

// #218 INIT_ACC - per-cell runoff seed. ocean->0; land = precip (pole-
// damped) floored at uAccMin so every land cell contributes discharge.
export const INIT_ACC_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform sampler2D uPrecip;",
  "uniform vec2 uGrid;",
  "uniform float uPoleBand;",
  "uniform float uAccMin;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a = loadA(uA, uGrid, rc.x, rc.y);",
  "  if (a.a > 0.5) { fragColor = vec4(0.0); return; }",
  "  float wLat = wLatOf(rc.y, uGrid, uPoleBand);",
  "  float p = loadF(uPrecip, uGrid, rc.x, rc.y).r;",
  "  float seed = max(uAccMin, p) * wLat;",
  "  fragColor = vec4(fin(seed), 0.0, 0.0, 0.0);",
  "}",
].join("\n");

// #218 ACCUM - one MFD gather iteration (ping-pong on ACC). For this land
// cell c: acc = seed(c) + sum over the 8 neighbours n HIGHER than c of
// Acc(n)*share(n->c), share = n's slope-weighted MFD split toward its
// lower neighbours (donor-normalised). Ocean = infinitely-low sink.
// Longitude wraps / poles clamp via loadA. finite-guarded; ocean->0.
export const ACCUM_FRAG = [
  H,
  "const ivec2 NB[8] = ivec2[8](ivec2(-1,0),ivec2(1,0),ivec2(0,-1),ivec2(0,1),ivec2(-1,-1),ivec2(1,-1),ivec2(-1,1),ivec2(1,1));",
  "const float ND[8] = float[8](1.0,1.0,1.0,1.0,1.41421356,1.41421356,1.41421356,1.41421356);",
  "uniform sampler2D uA;",
  "uniform sampler2D uAcc;",
  "uniform sampler2D uPrecip;",
  "uniform vec2 uGrid;",
  "uniform float uSfdJitter;",
  "uniform float uPoleBand;",
  "uniform float uAccMin;",
  "uniform sampler2D uCtrl;",
  "uniform float uRadialStrength;",
  "uniform float uParallelStrength;",
  "uniform float uCentripetalStrength;",
  "uniform float uUniformityThreshold;",
  "uniform float uCurvatureScale;",
  "uniform float uPatternMax;",
  "float hgt(vec2 g, int x, int y){ vec4 q = loadA(uA, g, x, y); return q.a > 0.5 ? -1.0e30 : q.r; }",
  "float jit(int x, int y, int j){ return fract(sin(float(x)*12.9898 + float(y)*78.233 + float(j)*37.719) * 43758.5453); }",
  // n's single steepest-descent neighbour index 0..7 (ocean = sink, so a
  // coastal cell drains to sea); -1 if n is a pit (no positive descent).
  // A tiny deterministic jitter breaks exact ties / D8 axis-locking.
  "vec4 patternW(vec4 ctrl){",
  "  float aRad = uRadialStrength * smoothstep(0.5, 0.0, ctrl.b);",
  "  float aPar = uParallelStrength * smoothstep(uUniformityThreshold, 1.0, ctrl.g);",
  "  float aCen = uCentripetalStrength * ctrl.a;",
  "  float sum = aRad + aPar + aCen;",
  "  float scl = sum > uPatternMax ? uPatternMax / max(sum,1.0e-6) : 1.0;",
  "  aRad*=scl; aPar*=scl; aCen*=scl;",
  "  return vec4(1.0 - (aRad+aPar+aCen), aRad, aPar, aCen);",
  "}",
  "float patternBias(int j, vec4 ctrl, vec4 w){",
  "  vec2 dj = normalize(vec2(NB[j]));",
  "  float th = ctrl.r * 6.28318530 - 3.14159265;",
  "  vec2 sd2 = vec2(cos(th), sin(th));",
  "  float align = dot(dj, sd2);",
  "  float bias = (w.y * align + w.z * align);",
  "  return (1.0 - ctrl.a) * bias;",
  "}",
  "int sdir(vec2 g, int x, int y, float bn, vec4 ctrl, vec4 w){",
  "  int best=-1; float bestM=0.0; float maxDrop=1.0e-6;",
  "  for (int j=0;j<8;j++){ float d=bn-hgt(g,x+NB[j].x,y+NB[j].y); if(d>maxDrop) maxDrop=d; }",
  "  for (int j=0;j<8;j++){",
  "    float drop = bn - hgt(g, x+NB[j].x, y+NB[j].y);",
  "    if (drop <= 0.0) continue;",
  "    float m = drop / ND[j]",
  "            + maxDrop * patternBias(j, ctrl, w)",
  "            + uSfdJitter * (jit(x,y,j) - 0.5);",
  "    if (best<0 || m>bestM){ bestM=m; best=j; }",
  "  }",
  "  return best;",
  "}",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a = loadA(uA, uGrid, rc.x, rc.y);",
  "  if (a.a > 0.5) { fragColor = vec4(0.0); return; }",
  "  float wLat = wLatOf(rc.y, uGrid, uPoleBand);",
  "  float acc = max(uAccMin, loadF(uPrecip, uGrid, rc.x, rc.y).r) * wLat;",
  // Single-flow gather: neighbour n contributes its FULL accumulation iff
  // n's steepest-descent target is THIS cell -> Q is a true drainage tree.
  "  for (int i = 0; i < 8; i++){",
  "    int nx = rc.x + NB[i].x;",
  "    int ny = rc.y + NB[i].y;",
  "    float bn = hgt(uGrid, nx, ny);",
  "    if (bn < -1.0e29) continue;",
  "    vec4 nc = loadF(uCtrl, uGrid, nx, ny);",
  "    int sd = sdir(uGrid, nx, ny, bn, nc, patternW(nc));",
  "    if (sd < 0) continue;",
  "    if (nx + NB[sd].x == rc.x && ny + NB[sd].y == rc.y){",
  "      acc += loadF(uAcc, uGrid, nx, ny).r;",
  "    }",
  "  }",
  "  fragColor = vec4(fin(acc), 0.0, 0.0, 0.0);",
  "}",
].join("\n");

export const CARVE_RIVERS_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform sampler2D uAcc;",
  "uniform sampler2D uDetailMask;",
  "uniform vec2 uGrid;",
  "uniform float uDt;",
  "uniform float uStreamK;",
  "uniform float uSpM;",
  "uniform float uSpN;",
  "uniform float uAccResScale;",
  "uniform float uVerticality;",
  "uniform float uTerrainScale;",
  "uniform float uSinMin;",
  "uniform float uConcaveScale;",
  "uniform float uChannelDepth;",
  "uniform float uPoleBand;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a = loadA(uA, uGrid, rc.x, rc.y);",
  "  bool ocean = a.a > 0.5;",
  "  if (ocean) { fragColor = a; return; }",
  "  vec4 aL = loadA(uA, uGrid, rc.x - 1, rc.y);",
  "  vec4 aR = loadA(uA, uGrid, rc.x + 1, rc.y);",
  "  vec4 aB = loadA(uA, uGrid, rc.x,     rc.y - 1);",
  "  vec4 aT = loadA(uA, uGrid, rc.x,     rc.y + 1);",
  "  float Q = loadF(uAcc, uGrid, rc.x, rc.y).r * uAccResScale;",
  "  float dbx = (aR.r - aL.r) * 0.5;",
  "  float dby = (aT.r - aB.r) * 0.5;",
  "  float gh = clamp(length(vec2(dbx, dby)), 0.0, 1.0e4);",
  "  float dx = uTerrainScale / max(1.0, uGrid.x);",
  "  float S = max(uSinMin, (gh * uVerticality) / max(1.0e-6, dx));",
  "  float sp = uStreamK * pow(max(Q, 0.0), uSpM) * pow(max(S, 0.0), uSpN);",
  "  float lap = (aL.r + aR.r + aB.r + aT.r) * 0.25 - a.r;",
  "  float concave = smoothstep(0.0, uConcaveScale, lap);",
  "  float dm = loadA(uDetailMask, uGrid, rc.x, rc.y).r;",
  "  float wLat = wLatOf(rc.y, uGrid, uPoleBand);",
  "  float carve = sp * concave * dm * uDt * wLat;",
  "  carve = max(0.0, fin(carve));",
  "  float nb = a.r - carve;",
  "  float minNb = a.r;",
  "  if (!(aL.a > 0.5)) minNb = min(minNb, aL.r);",
  "  if (!(aR.a > 0.5)) minNb = min(minNb, aR.r);",
  "  if (!(aB.a > 0.5)) minNb = min(minNb, aB.r);",
  "  if (!(aT.a > 0.5)) minNb = min(minNb, aT.r);",
  // R1a: per-step incision budget — 1e-3 floor everywhere (anti-moat on
  // convex/rim cells where concave~0), opened up on concave valley cells
  // in proportion to discharge so high-Q channels cut DEEP while
  // interfluves barely move -> channel/ridge contrast (dendritic).
  "  float budget = 1.0e-3 + uChannelDepth * concave * pow(max(Q, 0.0), uSpM);",
  "  nb = fin(max(nb, minNb - budget));",
  "  fragColor = vec4(nb, a.g, a.b, a.a);",
  "}",
].join("\n");

// #226 CONTROLS - per-cell terrain controls for the pattern blend.
// .r=regional slope azimuth (turns 0..1), .g=slope uniformity 0..1,
// .b=peak/basin curvature 0..1 (>0.5 basin/convergent, <0.5 dome),
// .a=endorheic flag (1=closed inland basin). Ocean cells -> all 0.
export const CONTROLS_FRAG = [
  H,
  "const ivec2 NB8[8] = ivec2[8](ivec2(-1,0),ivec2(1,0),ivec2(0,-1),ivec2(0,1),ivec2(-1,-1),ivec2(1,-1),ivec2(-1,1),ivec2(1,1));",
  "const float ND8[8] = float[8](1.0,1.0,1.0,1.0,1.41421356,1.41421356,1.41421356,1.41421356);",
  "uniform sampler2D uA;",
  "uniform vec2 uGrid;",
  "uniform float uCtrlRadius;",
  "uniform float uEndorheicSteps;",
  "uniform float uCurvatureScale;",
  "float h2(int x,int y){ vec4 q=loadA(uA,uGrid,x,y); return q.a>0.5 ? 0.0 : q.r; }",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a = loadA(uA, uGrid, rc.x, rc.y);",
  "  if (a.a > 0.5) { fragColor = vec4(0.0); return; }",
  "  int R = int(uCtrlRadius + 0.5);",
  "  float sx=0.0, sy=0.0, mean=0.0; int n=0;",
  "  vec2 av = vec2(0.0);",
  "  for (int dy=-8; dy<=8; dy++){",
  "    if (dy < -R || dy > R) continue;",
  "    for (int dx=-8; dx<=8; dx++){",
  "      if (dx < -R || dx > R) continue;",
  "      float hL = h2(rc.x+dx-1, rc.y+dy);",
  "      float hR = h2(rc.x+dx+1, rc.y+dy);",
  "      float hB = h2(rc.x+dx, rc.y+dy-1);",
  "      float hT = h2(rc.x+dx, rc.y+dy+1);",
  "      vec2 g = vec2(hR-hL, hT-hB);",
  "      sx += g.x; sy += g.y;",
  "      float L = length(g);",
  "      if (L > 1.0e-9) av += g / L;",
  "      mean += h2(rc.x+dx, rc.y+dy);",
  "      n++;",
  "    }",
  "  }",
  "  float fn = float(max(n,1));",
  "  float az = atan(-sy, -sx);",
  "  float azN = (az + 3.14159265) / 6.28318530;",
  "  float uniformity = clamp(length(av) / fn, 0.0, 1.0);",
  "  float curv = (mean / fn) - a.r;",
  "  float curvN = clamp(0.5 + 0.5 * (curv / max(1.0e-6, uCurvatureScale)), 0.0, 1.0);",
  "  int cx = rc.x; int cy = rc.y; float endo = 1.0;",
  "  int steps = int(uEndorheicSteps + 0.5);",
  "  for (int s=0; s<512; s++){",
  "    if (s >= steps) break;",
  "    vec4 cc = loadA(uA, uGrid, cx, cy);",
  "    if (cc.a > 0.5) { endo = 0.0; break; }",
  "    float bn = cc.r; int best=-1; float bestM=0.0;",
  "    for (int j=0;j<8;j++){",
  "      vec4 nq = loadA(uA, uGrid, cx+NB8[j].x, cy+NB8[j].y);",
  "      float hh = nq.a>0.5 ? -1.0e30 : nq.r;",
  "      float drop = bn - hh;",
  "      if (drop <= 0.0) continue;",
  "      float m = drop / ND8[j];",
  "      if (best<0 || m>bestM){ bestM=m; best=j; }",
  "    }",
  "    if (best < 0) { endo = 1.0; break; }",
  "    cx = cx + NB8[best].x; cy = cy + NB8[best].y;",
  "  }",
  "  fragColor = vec4(fin(azN), fin(uniformity), fin(curvN), endo);",
  "}",
].join("\n");

// Phase-2 P2.1 — placeholder fill for the climate/mask stack targets.
// P2.1 only proves alloc/co-evolution/dispose wiring at up to ~3M and
// that an UNCONSUMED stack is byte-transparent to #218 erosion. P2.2+
// replace this with the real climate/mask passes.
export const CLIMATE_NOOP_FRAG = [
  H,
  "void main(){ fragColor = vec4(0.0); }",
].join("\n");

// #234 P2.2 — annual-mean analytic climate (climate.rs transcription).
// CLIM.r=temperature °C, .g=precip 0..1, .b=wind azimuth (turns),
// .a=glaciation 0..1. Topography-only; continentality / orographic /
// ocean-current anomaly are P2.2-oro. Pure function of (height,
// latitude, params) — co-evolves each refresh.
export const CLIMATE_FRAG = [
  H,
  "uniform sampler2D uA;",
  "uniform vec2 uGrid;",
  "uniform float uTEquatorC;",
  "uniform float uTLatDropC;",
  "uniform float uLapseCPerKm;",
  "uniform float uElevKmScale;",
  "uniform float uItczWidthDeg;",
  "uniform float uGlacOnsetC;",
  "uniform float uGlacFullC;",
  "void main(){",
  "  ivec2 rc = fragRC();",
  "  vec4 a = loadA(uA, uGrid, rc.x, rc.y);",
  "  ivec2 wh = ivec2(int(uGrid.x + 0.5), int(uGrid.y + 0.5));",
  "  float v = (float(rc.y) + 0.5) / float(wh.y);",
  "  float lat = (0.5 - v) * 3.14159265;",
  "  float s = sin(lat);",
  "  float dDeg = abs(lat) * 57.2957795;",
  "  float h = a.r;",
  "  float elevKm = max(0.0, h) * uElevKmScale;",
  "  float T = uTEquatorC - uTLatDropC * (s * s) - uLapseCPerKm * elevKm;",
  "  float itcz    = 1.0 - smoothstep(0.0, uItczWidthDeg, dDeg);",
  "  float subtrop = 1.0 - smoothstep(0.0, 12.0, abs(dDeg - 30.0));",
  "  float midlat  = 1.0 - smoothstep(0.0, 14.0, abs(dDeg - 58.0));",
  "  float polar   = smoothstep(62.0, 82.0, dDeg);",
  "  float P = clamp(0.85*itcz - 0.6*subtrop + 0.55*midlat - 0.4*polar + 0.35, 0.0, 1.0);",
  "  float zsign = (dDeg < 30.0) ? -1.0 : ((dDeg < 60.0) ? 1.0 : -1.0);",
  "  float towardEq = (lat >= 0.0) ? -1.0 : 1.0;",
  "  vec2 wv = normalize(vec2(zsign, towardEq * 0.15));",
  "  float windAz = (atan(wv.y, wv.x) + 3.14159265) / 6.28318530;",
  // SPEC-SAFE: GLSL ES 3.00 smoothstep is UNDEFINED if edge0 >= edge1.
  // uGlacOnsetC (-2) > uGlacFullC (-12), so keep edges ASCENDING
  // (uGlacFullC, uGlacOnsetC) and invert the result: T >= -2 -> 1 ->
  // glac 0 (no ice); T <= -12 -> 0 -> glac 1 (full ice). Identical
  // curve to the intended colder=>more-ice ramp, portable on all WebGL.
  "  float glac = 1.0 - smoothstep(uGlacFullC, uGlacOnsetC, T);",
  "  fragColor = vec4(fin(T), fin(P), fin(windAz), clamp(fin(glac), 0.0, 1.0));",
  "}",
].join("\n");
