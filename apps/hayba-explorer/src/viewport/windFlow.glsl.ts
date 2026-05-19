// NX-3-v2b WINDFLOW — Eulerian semi-Lagrangian advected-dye flow-map.
// Back-advect the trail by the geostrophic WIND vector, fade (MdGBWG
// z=0.9*prev), inject sparse time-seeded births, speed-glow so calm
// air stays near-black. Display-only; reads WIND read-only.
export const WINDFLOW_FRAG = [
  "uniform sampler2D uPrevTrail;",
  "uniform sampler2D uWind;",
  "uniform vec2 uGrid;",
  "uniform float uDt;",
  "uniform float uTime;",
  "const float ADV_K = 0.18;",
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
  "  vec2 prevUv = uv - v * uDt * ADV_K;",
  "  prevUv.x = fract(prevUv.x);",
  "  prevUv.y = clamp(prevUv.y, 0.0, 1.0);",
  "  float prev = texture(uPrevTrail, prevUv).r;",
  "  float trail = prev * 0.9;",
  "  float seed = hash(floor(uv * uGrid) + floor(uTime * 24.0));",
  "  trail = max(trail, step(SEED_THR, seed));",
  "  float g = trail * smoothstep(0.0, SPD_REF, spd);",
  "  fragColor = vec4(vec3(g), 1.0);",
  "}",
].join("\n");
