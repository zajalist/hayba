// NX-3-v2c WINDFLOW shaders — MdGBWG Buffer C-faithful Lagrangian
// particles. INIT seeds the 64x64 particle state; ADVECT integrates
// position along the normalised wind direction + ages + respawns
// (deterministic per-particle hash); FADE multiplies the trail by
// 0.9; SPLAT_VERT positions each point by `gl_VertexID` indexing
// into the particle state texture; SPLAT_FRAG emits a soft round
// dot whose brightness is gated by |wind| and fades with age.
// Display-only; reads WIND read-only; trail RT is engine-private.

const HASH = [
  "float hash(vec2 p){",
  "  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);",
  "}",
  "float hash(float p){",
  "  return fract(sin(p * 78.233) * 43758.5453);",
  "}",
].join("\n");

const LIFE_DECL = "const float LIFE = 2.5;";
const STEP_K_DECL = "const float STEP_K = 0.10;";
const SPD_REF_DECL = "const float SPD_REF = 0.55;";
const V_REF_DECL = "const float V_REF = 1.0;";
const STALL_THRESH_DECL = "const float STALL_THRESH = 0.15;";

export const INIT_FRAG = [
  "uniform vec2 uGrid;",
  LIFE_DECL,
  "out vec4 fragColor;",
  HASH,
  "void main(){",
  "  vec2 fc = gl_FragCoord.xy;",
  "  float h1 = hash(fc);",
  "  float h2 = hash(fc + vec2(13.7, 91.3));",
  "  float h3 = hash(fc + vec2(57.1, 4.6));",
  "  float h4 = hash(fc + vec2(31.2, 22.9));",
  "  fragColor = vec4(h1, h2, LIFE * h3, h4);",
  "}",
].join("\n");

export const ADVECT_FRAG = [
  "uniform sampler2D uPrev;",
  "uniform sampler2D uWind;",
  "uniform vec2 uGrid;",
  "uniform float uDt;",
  "uniform float uTime;",
  LIFE_DECL,
  STEP_K_DECL,
  V_REF_DECL,
  STALL_THRESH_DECL,
  "out vec4 fragColor;",
  HASH,
  "void main(){",
  "  ivec2 rc = ivec2(gl_FragCoord.xy);",
  "  vec4 s = texelFetch(uPrev, rc, 0);",
  "  vec2 pos = s.xy;",
  "  float age = s.z;",
  "  float seed = s.w;",
  "  vec2 v = texture(uWind, pos).xy;",
  "  float vlen = length(v);",
  "  // Magnitude-aware advection with soft cap: at |v|>=V_REF particles",
  "  // move at full STEP_K (the old direction-normalised speed); at",
  "  // |v|<V_REF they slow proportionally so stagnation points produce",
  "  // ~zero motion (which the STALL_THRESH respawn then catches).",
  "  vec2 motion = v * (STEP_K / max(vlen, V_REF));",
  "  pos += motion * uDt;",
  "  pos.x = fract(pos.x);",
  "  pos.y = clamp(pos.y, 0.0, 1.0);",
  "  age += uDt;",
  "  if (age > LIFE || vlen < STALL_THRESH) {",
  "    seed = hash(seed + uTime * 7.0);",
  "    pos = vec2(hash(seed + 1.0), hash(seed + 2.0));",
  "    age = 0.0;",
  "  }",
  "  fragColor = vec4(pos, age, seed);",
  "}",
].join("\n");

export const FADE_FRAG = [
  "uniform sampler2D uPrevTrail;",
  "uniform vec2 uGrid;",
  "out vec4 fragColor;",
  "void main(){",
  "  vec2 uv = gl_FragCoord.xy / uGrid;",
  "  vec3 t = texture(uPrevTrail, uv).rgb;",
  "  fragColor = vec4(t * 0.9, 1.0);",
  "}",
].join("\n");

export const SPLAT_VERT = [
  "uniform sampler2D uPart;",
  "uniform vec2 uPartDim;",
  "uniform sampler2D uWind;",
  "uniform sampler2D uClim;",
  LIFE_DECL,
  SPD_REF_DECL,
  "out float v_intensity;",
  "out vec3 v_color;",
  "void main(){",
  "  int id = gl_VertexID;",
  "  int w = int(uPartDim.x);",
  "  ivec2 rc = ivec2(id - (id / w) * w, id / w);",
  "  vec4 s = texelFetch(uPart, rc, 0);",
  "  vec2 pos = s.xy;",
  "  float age = s.z;",
  "  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);",
  "  gl_PointSize = 2.5;",
  "  float spd = texture(uWind, pos).z;",
  "  float speedGate = smoothstep(0.0, SPD_REF, spd);",
  "  float ageFade = 1.0 - smoothstep(LIFE * 0.7, LIFE, age);",
  "  v_intensity = speedGate * ageFade;",
  "  float tempC = texture(uClim, pos).r;",
  "  float tn = clamp((tempC + 20.0) / 50.0, 0.0, 1.0);",
  "  vec3 cold = vec3(0.30, 0.55, 1.00);",
  "  vec3 mild = vec3(0.95, 0.95, 0.90);",
  "  vec3 hot  = vec3(1.00, 0.45, 0.20);",
  "  v_color = mix(mix(cold, mild, smoothstep(0.0, 0.5, tn)), hot, smoothstep(0.5, 1.0, tn));",
  "}",
].join("\n");

export const SPLAT_FRAG = [
  "in float v_intensity;",
  "in vec3 v_color;",
  "out vec4 fragColor;",
  "void main(){",
  "  vec2 d = gl_PointCoord - 0.5;",
  "  float falloff = smoothstep(0.5, 0.0, length(d));",
  "  fragColor = vec4(v_color * v_intensity * falloff, 1.0);",
  "}",
].join("\n");
