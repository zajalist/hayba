// Hero orb composition rendered as a single WebGL fragment shader.
// Linear-RGB accumulation, sRGB encode, TPDF dither at 1 LSB → no banding.
//
// Caller mounts on a <canvas>; we drive orb positions per-frame via uniforms.

import { mountQuad } from './gl-quad.js';

const N = 22;

const PAL_SRGB = [
  [0.710, 0.416, 0.114], // #B56A1D ember
  [0.843, 0.498, 0.141], // #d77f24 bright ember
  [0.478, 0.271, 0.078], // #7a4514 dim ember
  [0.114, 0.227, 0.290], // #1d3a4a navy
  [0.141, 0.188, 0.251], // #243040 slate-blue
  [0.086, 0.098, 0.122], // #16191f shadow well
];
const PAL_LIN = PAL_SRGB.map((rgb) => rgb.map((v) => Math.pow(v, 2.2)));
// Balanced: warm 4+1+2=7 ; cool 3+3=6 ; shadow 2
const PAL_WEIGHTS = [4, 1, 2, 3, 3, 2];

function rand(a, b) { return a + Math.random() * (b - a); }

function makeOrbs() {
  const weighted = [];
  PAL_WEIGHTS.forEach((w, i) => { for (let k = 0; k < w; k++) weighted.push(i); });
  return Array.from({ length: N }, () => {
    const palIdx = weighted[Math.floor(Math.random() * weighted.length)];
    const isShadow = palIdx === 5;
    const isCool = palIdx === 3 || palIdx === 4;
    const intensity = isShadow
      ? -rand(0.55, 0.85)
      : isCool
        ? rand(0.30, 0.55)
        : rand(0.22, 0.50);
    return {
      ax: rand(-0.1, 1.05),
      ay: rand(-0.15, 1.05),
      baseR: rand(0.10, 0.32),
      col: PAL_LIN[palIdx],
      intensity,
      driftAmp: rand(0.04, 0.10),
      driftPhX: rand(0, Math.PI * 2),
      driftPhY: rand(0, Math.PI * 2),
      driftSpX: rand(0.04, 0.10),
      driftSpY: rand(0.04, 0.10),
      breathePh: rand(0, Math.PI * 2),
      breatheSp: rand(0.30, 0.70),
    };
  });
}

const FS = `
  precision highp float;
  uniform vec2 u_res;
  uniform float u_time;
  uniform vec3 u_pos[${N}];
  uniform vec3 u_col[${N}];

  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec3 tpdfNoise(vec2 fc, float seed) {
    vec3 a = vec3(
      hash21(fc + vec2(seed + 0.0,  3.7)),
      hash21(fc + vec2(seed + 11.3, 5.1)),
      hash21(fc + vec2(seed + 7.9,  17.2))
    );
    vec3 b = vec3(
      hash21(fc + vec2(seed + 23.1, 91.7)),
      hash21(fc + vec2(seed + 47.2, 13.5)),
      hash21(fc + vec2(seed + 5.6,  61.3))
    );
    return a - b;
  }
  vec3 toSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
    bvec3 cutoff = lessThan(c, vec3(0.0031308));
    return mix(hi, lo, vec3(cutoff));
  }
  float orbFalloff(vec2 d, float r) {
    return exp(- pow(length(d) / max(r, 1e-4), 1.6));
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_res.xy;
    float aspect = u_res.x / u_res.y;
    vec2 p = uv; p.x *= aspect;

    vec3 col = vec3(0.0050, 0.0060, 0.0078);

    float ang = u_time * 0.045;
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 cc = uv - 0.5;
    float warmA = max(0.0, dot(cc, dir)) * 0.55;
    float coolA = max(0.0, dot(cc, -dir)) * 0.30;
    col += vec3(0.020, 0.009, 0.0028) * warmA;
    col += vec3(0.0022, 0.0060, 0.0110) * coolA;

    for (int i = 0; i < ${N}; i++) {
      vec3 pos = u_pos[i];
      vec2 d = p - pos.xy;
      float g = orbFalloff(d, pos.z);
      col += u_col[i] * g;
    }

    float pulseX = mod(u_time * 0.034, 1.4) - 0.2;
    float pulse = exp(- pow((uv.x - pulseX) * 3.6, 2.0))
                * exp(- pow((uv.y - 0.5)   * 2.2, 2.0));
    col += vec3(0.022, 0.012, 0.0048) * pulse;

    vec3 tint = mix(
      vec3(0.0058, 0.0110, 0.0170),
      vec3(0.0022, 0.0048, 0.0090),
      uv.y
    );
    col += tint * 0.55;
    col *= mix(vec3(1.0), vec3(0.92, 0.97, 1.06), 0.14);

    vec2 vc = (uv - 0.5);
    vc.x *= aspect;
    float r2 = dot(vc, vc);
    float vig = 1.0 - smoothstep(0.20, 0.62, r2);
    col *= 0.55 + 0.45 * vig;

    col = toSRGB(col);
    vec3 noise = tpdfNoise(gl_FragCoord.xy, fract(u_time * 0.5) * 100.0);
    col += noise * (1.0 / 255.0);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function mountHeroField(canvas) {
  const orbs = makeOrbs();
  return mountQuad(canvas, {
    fragmentShader: FS,
    onFrame: ({ gl, time, width, height, aspect, uniform }) => {
      gl.uniform2f(uniform('u_res'), width, height);
      gl.uniform1f(uniform('u_time'), time);
      for (let i = 0; i < N; i++) {
        const o = orbs[i];
        const dx = Math.sin(o.driftPhX + time * o.driftSpX) * o.driftAmp;
        const dy = Math.sin(o.driftPhY + time * o.driftSpY) * o.driftAmp;
        gl.uniform3f(uniform(`u_pos[${i}]`), (o.ax + dx) * aspect, o.ay + dy,
          o.baseR * (0.8 + 0.4 * Math.sin(o.breathePh + time * o.breatheSp)));
        const k = o.intensity * (0.8 + 0.4 * Math.sin(o.breathePh + time * o.breatheSp));
        gl.uniform3f(uniform(`u_col[${i}]`), o.col[0] * k, o.col[1] * k, o.col[2] * k);
      }
    },
  });
}
