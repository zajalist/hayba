import * as THREE from "three";
import type { HeightPainter } from "../wizard/paint/HeightPainter";

const VERTEX_FULL = /* glsl */`
attribute float elevation;
varying float vElev;
varying vec3 vNormalW;
uniform float uExaggeration;

void main() {
  vElev = elevation;
  vNormalW = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec3 p = position * (1.0 + elevation * uExaggeration);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const FRAGMENT = /* glsl */`
precision highp float;
varying float vElev;
varying vec3 vNormalW;
uniform vec3 uSunDir;

// Compact value-noise fbm to break the per-cell hexagonal coastline in the
// compose preview: perturb the colour-ramp coordinate so the land/sea (and
// depth) thresholds wander sub-cell instead of tracing cell polygons.
float h3(vec3 p){ p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p, p.yzx + 19.19); return fract((p.x + p.y) * p.z); }
float vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i),                h3(i+vec3(1,0,0)), f.x),
                 mix(h3(i+vec3(0,1,0)),    h3(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i+vec3(0,0,1)),    h3(i+vec3(1,0,1)), f.x),
                 mix(h3(i+vec3(0,1,1)),    h3(i+vec3(1,1,1)), f.x), f.y), f.z); }
float fbm3(vec3 p){ float v = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++){ v += vn(p) * a; p *= 2.0; a *= 0.5; } return v; }

vec3 heightRamp(float e) {
  vec3 abyss   = vec3(0.012, 0.055, 0.150);
  vec3 deep    = vec3(0.039, 0.180, 0.361);
  vec3 shallow = vec3(0.290, 0.565, 0.784);
  vec3 beach   = vec3(0.784, 0.722, 0.604);
  vec3 low     = vec3(0.482, 0.627, 0.357);
  vec3 high    = vec3(0.541, 0.416, 0.227);
  vec3 snow    = vec3(1.000, 1.000, 1.000);

  if (e < -0.4) return mix(abyss, deep, clamp((e + 1.0) / 0.6, 0.0, 1.0));
  if (e < 0.0)  return mix(deep, shallow, (e + 0.4) / 0.4);
  if (e < 0.05) return mix(shallow, beach, e / 0.05);
  if (e < 0.3)  return mix(beach, low, (e - 0.05) / 0.25);
  if (e < 0.7)  return mix(low, high, (e - 0.3) / 0.4);
  return mix(high, snow, min((e - 0.7) / 0.3, 1.0));
}

void main() {
  // Sub-cell domain warp of the ramp coordinate → organic coast/bands,
  // not a hexagonal staircase tracing the painted cells.
  float warp = (fbm3(vNormalW * 7.0)  - 0.5) * 0.11
             + (fbm3(vNormalW * 19.0) - 0.5) * 0.05;
  vec3 base = heightRamp(vElev + warp);
  float lambert = max(dot(normalize(vNormalW), normalize(uSunDir)), 0.0);
  vec3 lit = base * (0.45 + 0.55 * lambert);
  gl_FragColor = vec4(lit, 1.0);
}
`;

export interface PainterMeshHandle {
  object: THREE.Object3D;
  cursorRing: THREE.Line;
  /** Push painter state to GPU. Cheap when painter.dirty is false. */
  syncFromPainter(painter: HeightPainter): void;
  /** Update brush cursor position + radius. Pass null hit to hide. */
  setCursor(hit: [number, number, number] | null, radiusRad: number, pressed: boolean): void;
  dispose(): void;
}

export function buildPainterMesh(args: {
  positions: Float32Array;     // length n*3, unit sphere
  triangles: Uint32Array;
  initialElevations: Float32Array;
}): PainterMeshHandle {
  const { positions, triangles, initialElevations } = args;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(triangles, 1));
  const elevAttr = new THREE.BufferAttribute(new Float32Array(initialElevations), 1);
  elevAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("elevation", elevAttr);
  geom.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_FULL,
    fragmentShader: FRAGMENT,
    uniforms: {
      uExaggeration: { value: 0.05 },
      uSunDir:       { value: new THREE.Vector3(0.6, 0.5, 0.8).normalize() },
    },
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "hayba-painter-mesh";

  // Brush cursor ring — 64-segment circle on unit sphere, transformed each frame.
  const ringGeom = new THREE.BufferGeometry();
  const ringSegments = 64;
  const ringPositions = new Float32Array((ringSegments + 1) * 3);
  for (let i = 0; i <= ringSegments; i++) {
    const t = (i / ringSegments) * Math.PI * 2;
    ringPositions[i * 3 + 0] = Math.cos(t);
    ringPositions[i * 3 + 1] = 0;
    ringPositions[i * 3 + 2] = Math.sin(t);
  }
  ringGeom.setAttribute("position", new THREE.BufferAttribute(ringPositions, 3));
  const ringMat = new THREE.LineBasicMaterial({
    color: new THREE.Color("#DED4C3"),
    transparent: true,
    opacity: 0.85,
    depthTest: false,
  });
  const cursorRing = new THREE.Line(ringGeom, ringMat);
  cursorRing.renderOrder = 20;
  cursorRing.visible = false;
  cursorRing.frustumCulled = false;

  const group = new THREE.Group();
  group.name = "painter-group";
  group.add(mesh);
  group.add(cursorRing);

  const syncFromPainter = (painter: HeightPainter): void => {
    if (!painter.dirty) return;
    (elevAttr.array as Float32Array).set(painter.elevations);
    elevAttr.needsUpdate = true;
    painter.dirty = false;
  };

  const setCursor = (
    hit: [number, number, number] | null,
    radiusRad: number,
    pressed: boolean,
  ): void => {
    if (!hit) { cursorRing.visible = false; return; }
    cursorRing.visible = true;
    ringMat.opacity = pressed ? 0.95 : 0.6;
    const r = Math.sin(radiusRad);
    cursorRing.scale.set(r, r, r);
    const dist = Math.cos(radiusRad) * 1.001;
    cursorRing.position.set(hit[0] * dist, hit[1] * dist, hit[2] * dist);
    const up = new THREE.Vector3(hit[0], hit[1], hit[2]);
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    cursorRing.quaternion.copy(quat);
  };

  const dispose = (): void => {
    geom.dispose();
    mat.dispose();
    ringGeom.dispose();
    ringMat.dispose();
  };

  return { object: group, cursorRing, syncFromPainter, setCursor, dispose };
}
