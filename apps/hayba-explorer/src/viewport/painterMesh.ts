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
  /** Recolor the brush preview (rings + dot) by hex string. Photoshop-style
   *  mode tint: amber=Raise, ice=Lower, beige=Smooth, pink=Flatten, etc. */
  setCursorColor(hex: string): void;
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

  // Photoshop-style brush preview — outer ring (full radius) + inner
  // dashed-feel ring (45% radius, dim) for falloff hint + a centre dot.
  // All three live on a single transform; setCursor() positions the parent.
  const ringSegments = 96;
  const buildCircleGeom = (): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    const pts = new Float32Array((ringSegments + 1) * 3);
    for (let i = 0; i <= ringSegments; i++) {
      const t = (i / ringSegments) * Math.PI * 2;
      pts[i * 3 + 0] = Math.cos(t);
      pts[i * 3 + 1] = 0;
      pts[i * 3 + 2] = Math.sin(t);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
    return g;
  };
  const outerGeom = buildCircleGeom();
  const innerGeom = buildCircleGeom();
  const outerMat = new THREE.LineBasicMaterial({
    color: new THREE.Color("#DED4C3"),
    transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
  });
  const innerMat = new THREE.LineBasicMaterial({
    color: new THREE.Color("#DED4C3"),
    transparent: true, opacity: 0.40, depthTest: false, depthWrite: false,
  });
  const outerRing = new THREE.Line(outerGeom, outerMat);
  const innerRing = new THREE.Line(innerGeom, innerMat);
  innerRing.scale.setScalar(0.45);
  // Centre dot — a single point at the brush centre for precise targeting.
  const dotGeom = new THREE.BufferGeometry();
  dotGeom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const dotMat = new THREE.PointsMaterial({
    color: new THREE.Color("#DED4C3"),
    size: 5,
    sizeAttenuation: false,
    transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
  });
  const centreDot = new THREE.Points(dotGeom, dotMat);
  const cursorPivot = new THREE.Group();
  cursorPivot.name = "brush-cursor";
  cursorPivot.add(outerRing, innerRing, centreDot);
  cursorPivot.renderOrder = 20;
  cursorPivot.visible = false;
  cursorPivot.frustumCulled = false;
  // Back-compat: callers still reference handle.cursorRing.
  const cursorRing = outerRing as unknown as THREE.Line;

  const group = new THREE.Group();
  group.name = "painter-group";
  group.add(mesh);
  group.add(cursorPivot);

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
    if (!hit) { cursorPivot.visible = false; return; }
    cursorPivot.visible = true;
    // Slight opacity lift while pressed so the brush feels "engaged".
    outerMat.opacity = pressed ? 1.0  : 0.85;
    innerMat.opacity = pressed ? 0.55 : 0.35;
    dotMat.opacity   = pressed ? 1.0  : 0.85;
    // Geodesic radius → chord radius on tangent plane.
    const r = Math.sin(radiusRad);
    outerRing.scale.set(r, r, r);
    innerRing.scale.set(r * 0.45, r * 0.45, r * 0.45);
    const dist = Math.cos(radiusRad) * 1.001;
    cursorPivot.position.set(hit[0] * dist, hit[1] * dist, hit[2] * dist);
    const up = new THREE.Vector3(hit[0], hit[1], hit[2]);
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    cursorPivot.quaternion.copy(quat);
  };

  /** Tint the brush preview by mode — Photoshop-style colour-coded cursor. */
  const setCursorColor = (hex: string): void => {
    const c = new THREE.Color(hex);
    outerMat.color.copy(c);
    innerMat.color.copy(c);
    dotMat.color.copy(c);
  };

  const dispose = (): void => {
    geom.dispose();
    mat.dispose();
    outerGeom.dispose(); outerMat.dispose();
    innerGeom.dispose(); innerMat.dispose();
    dotGeom.dispose();   dotMat.dispose();
  };

  return { object: group, cursorRing, syncFromPainter, setCursor, setCursorColor, dispose };
}
