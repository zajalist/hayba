import * as THREE from "three";

// Mulberry32 — small deterministic PRNG so the starfield is the same on every
// launch (a Hayba-ism: prefer determinism over surprise).
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERT = /* glsl */ `
attribute float aSize;
attribute float aTwinkleSeed;
varying float vAlpha;
uniform float uTime;
uniform float uPixelRatio;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Gentle twinkle: sin wave with per-star phase.
  float t = uTime * 0.6 + aTwinkleSeed * 6.2831853;
  float twinkle = 0.6 + 0.4 * sin(t);
  vAlpha = twinkle;
  gl_Position = projectionMatrix * mv;
  // Size falls off with distance; pixel-ratio scaling keeps stars crisp on HiDPI.
  gl_PointSize = aSize * uPixelRatio * (260.0 / -mv.z);
}
`;

const FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float falloff = smoothstep(0.5, 0.05, d);
  // Subtle white stars — twinkle modulates alpha, not hue.
  gl_FragColor = vec4(vec3(1.0), falloff * vAlpha * 0.45);
}
`;

export interface StarfieldHandle {
  object: THREE.Object3D;
  tick(dt: number): void;
  dispose(): void;
}

export function createStarfield(count = 2400, radius = 40): StarfieldHandle {
  const rand = mulberry32(0xB56A1D);
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const twinkleSeeds = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    // Uniform direction on the unit sphere via Marsaglia method,
    // then push out to a thick shell so distance variation gives parallax.
    let x = 0, y = 0, z = 0, s = 2;
    while (s >= 1) {
      x = rand() * 2 - 1;
      y = rand() * 2 - 1;
      s = x * x + y * y;
    }
    const t = 2 * Math.sqrt(1 - s);
    const ux = x * t;
    const uy = y * t;
    const uz = 1 - 2 * s;
    const r = radius * (0.85 + rand() * 0.4);
    positions[3 * i + 0] = ux * r;
    positions[3 * i + 1] = uy * r;
    positions[3 * i + 2] = uz * r;
    // Heavily skewed-small — most stars are pinpricks; a tail is just barely larger.
    const u = rand();
    sizes[i] = 0.25 + u * u * u * 1.0;
    twinkleSeeds[i] = rand();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute("aTwinkleSeed", new THREE.BufferAttribute(twinkleSeeds, 1));

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -10; // draw before the globe so it sits behind
  points.name = "hayba-starfield";

  // Slow yaw rotation — independent of camera, evokes the planet hanging in
  // space rather than the user being on a tripod.
  const group = new THREE.Group();
  group.add(points);
  group.name = "hayba-starfield-group";

  return {
    object: group,
    tick(dt) {
      mat.uniforms.uTime.value += dt;
      group.rotation.y += dt * 0.008;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
