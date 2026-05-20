// Watery overlay: continuous Gerstner-like wave field, specular highlights,
// caustic bands. Output blends with overlay over the hero field.

import { mountQuad } from './gl-quad.js';

const FS = `
  precision mediump float;
  uniform vec2 u_res;
  uniform float u_time;

  float field(vec2 uv) {
    vec2 p = uv * 3.0;
    p.x *= u_res.x / u_res.y;
    float t = u_time;
    float h = 0.0;
    h += 0.55 * sin(dot(p, vec2( 0.95,  0.31)) * 1.9 + t *  0.55);
    h += 0.42 * sin(dot(p, vec2(-0.50,  0.87)) * 2.4 + t *  0.72);
    h += 0.30 * sin(dot(p, vec2(-0.81, -0.59)) * 3.1 + t * -0.65);
    h += 0.22 * sin(dot(p, vec2( 0.31, -0.95)) * 3.8 + t *  0.85);
    h += 0.14 * sin(dot(p, vec2( 0.71,  0.71)) * 5.5 + t * -0.90);
    h += 0.10 * sin(dot(p, vec2(-0.93,  0.37)) * 6.8 + t *  1.05);
    return h * 0.40;
  }

  float caustics(vec2 uv) {
    vec2 p = uv * 4.5;
    p.x *= u_res.x / u_res.y;
    float t = u_time * 0.35;
    float a = sin(p.x * 1.6 + sin(p.y * 1.3 + t * 0.7) * 1.4 + t);
    float b = sin(p.y * 1.8 + sin(p.x * 1.5 - t * 0.5) * 1.4 + t * 0.6);
    return pow(max(0., a * b), 4.0);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_res.xy;
    float eps = 1.5 / u_res.y;
    float hL = field(uv - vec2(eps, 0.0));
    float hR = field(uv + vec2(eps, 0.0));
    float hU = field(uv - vec2(0.0, eps));
    float hD = field(uv + vec2(0.0, eps));
    vec3 n = normalize(vec3((hL - hR) * 45.0, (hU - hD) * 45.0, 1.0));
    vec3 L = normalize(vec3(0.45, 0.40, 0.80));
    float diff = max(0.0, dot(n, L));
    float spec = pow(diff, 48.0);
    float wide = pow(diff, 6.0) * 0.18;

    float caust = caustics(uv);
    float h = field(uv);

    float v = 0.5
            + spec * 0.45
            + wide
            + caust * 0.16
            - max(0., -h) * 0.10
            + h * 0.04;

    vec2 fc = gl_FragCoord.xy;
    float seed = fract(u_time * 0.5) * 100.0;
    float n1 = fract(sin(dot(fc + vec2(seed, 3.7),         vec2(12.9898, 78.233))) * 43758.5453);
    float n2 = fract(sin(dot(fc + vec2(seed + 23.1, 91.7), vec2(12.9898, 78.233))) * 43758.5453);
    v += (n1 - n2) * (1.0 / 255.0);

    gl_FragColor = vec4(vec3(v), 0.92);
  }
`;

export function mountRipples(canvas) {
  return mountQuad(canvas, {
    fragmentShader: FS,
    onFrame: ({ gl, time, width, height, uniform }) => {
      gl.uniform2f(uniform('u_res'), width, height);
      gl.uniform1f(uniform('u_time'), time);
    },
  });
}
