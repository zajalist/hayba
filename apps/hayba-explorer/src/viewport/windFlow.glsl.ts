// NX-3-v2b WINDFLOW — Eulerian advected-dye flow-map. Back-advect the
// trail along the NORMALISED wind DIRECTION by a small bounded
// per-frame step (raw |wvec| is unnormalised/large → advecting by it
// teleports the dye into a global drift; direction + clamped step is
// scale-robust). Speed (WIND.b) → glow + a mild streak-length factor,
// never step distance. Fade MdGBWG z=0.9*prev; sparse phase-offset
// births. Display-only; reads WIND read-only.
export const WINDFLOW_FRAG = [
  "uniform sampler2D uPrevTrail;",
  "uniform sampler2D uWind;",
  "uniform vec2 uGrid;",
  "uniform float uDt;",
  "uniform float uTime;",
  "const float STEP_TEX = 1.5;",
  "const float SPD_REF = 0.55;",
  "const float SEED_THR = 0.992;",
  "out vec4 fragColor;",
  "float hash(vec2 p){",
  "  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);",
  "}",
  "void main(){",
  "  vec2 uv = gl_FragCoord.xy / uGrid;",
  "  vec3 wv = texture(uWind, uv).rgb;",
  "  vec2 v = wv.xy;",
  "  float spd = wv.z;",
  "  float vlen = length(v);",
  "  vec2 dir = vlen > 1e-4 ? v / vlen : vec2(0.0);",
  "  float spdN = clamp(spd / SPD_REF, 0.0, 1.0);",
  "  float fr = clamp(uDt * 60.0, 0.5, 2.0);",
  "  float stepUv = (STEP_TEX / max(uGrid.x, uGrid.y)) * (0.15 + 0.85 * spdN) * fr;",
  "  vec2 prevUv = uv - dir * stepUv;",
  "  prevUv.x = fract(prevUv.x);",
  "  prevUv.y = clamp(prevUv.y, 0.0, 1.0);",
  "  float prev = texture(uPrevTrail, prevUv).r;",
  "  float trail = prev * 0.9;",
  "  float ph = hash(floor(uv * uGrid));",
  "  float seed = hash(floor(uv * uGrid) + floor(uTime * 6.0 + ph * 97.0));",
  "  trail = max(trail, step(SEED_THR, seed));",
  "  float g = trail * smoothstep(0.0, SPD_REF, spd);",
  "  fragColor = vec4(vec3(g), 1.0);",
  "}",
].join("\n");
