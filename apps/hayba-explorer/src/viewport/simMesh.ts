// Sim-mode per-cell mesh — minimal relief-ramp shader (no biome textures).
// Used during the Simulate phase where plates rotate, continents collide,
// and mountains rise. Bypasses the heavy biome-texturing pipeline (which is
// still WIP) — same height-driven colour ramp as the painter preview, just
// applied to the triangulated per-cell mesh with TickSnapshot updates.

import * as THREE from "three";

const VERTEX = /* glsl */`
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
  float warp = (fbm3(vNormalW * 7.0)  - 0.5) * 0.11
             + (fbm3(vNormalW * 19.0) - 0.5) * 0.05;
  vec3 base = heightRamp(vElev + warp);
  float lambert = max(dot(normalize(vNormalW), normalize(uSunDir)), 0.0);
  vec3 lit = base * (0.45 + 0.55 * lambert);
  gl_FragColor = vec4(lit, 1.0);
}
`;

export interface SimMeshHandle {
  object: THREE.Mesh;
  /** Update vertex positions + elevation + plate ownership. When plate
   *  ownership changes (cells transferred between plates by subduction),
   *  the index buffer is rebuilt to drop triangles that span multiple
   *  plates — without that, the triangle stretches across the drift gap
   *  and the mesh smears. */
  update(
    cellPositions: ArrayLike<number>,
    cellElevation: ArrayLike<number>,
    cellPlateIds: ArrayLike<number>,
  ): void;
  dispose(): void;
}

export function buildSimMesh(args: {
  positions: ArrayLike<number>; // length n*3, unit sphere coords
  triangles: Uint32Array;
  elevations: ArrayLike<number>;
  plateIds: ArrayLike<number>; // length n
}): SimMeshHandle {
  const { positions, triangles, elevations, plateIds } = args;
  const n = elevations.length;

  const geom = new THREE.BufferGeometry();
  const posArr = new Float32Array(n * 3);
  for (let i = 0; i < posArr.length; i++) posArr[i] = positions[i];
  const posBuf = new THREE.BufferAttribute(posArr, 3);
  posBuf.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("position", posBuf);

  const elevArr = new Float32Array(n);
  for (let i = 0; i < n; i++) elevArr[i] = elevations[i];
  const elevBuf = new THREE.BufferAttribute(elevArr, 1);
  elevBuf.setUsage(THREE.DynamicDrawUsage);
  geom.setAttribute("elevation", elevBuf);

  // Cache plate ids per cell and a current filtered index buffer. We
  // rebuild the index only when plate ownership changes between frames.
  const plateIdCache = new Int32Array(n);
  for (let i = 0; i < n; i++) plateIdCache[i] = plateIds[i] | 0;

  // Build the filtered index buffer: include only triangles whose 3
  // vertices share a plate_id (including all-three == -1, the "no plate"
  // ocean filler). This is what drops the cross-plate stretched
  // triangles that smear the mesh as plates drift apart.
  const filterTriangles = (out: Uint32Array): number => {
    let write = 0;
    for (let i = 0; i < triangles.length; i += 3) {
      const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
      const pa = plateIdCache[a], pb = plateIdCache[b], pc = plateIdCache[c];
      if (pa === pb && pb === pc) {
        out[write++] = a;
        out[write++] = b;
        out[write++] = c;
      }
    }
    return write;
  };

  // Allocate a reusable index buffer at the full triangles size — the
  // filtered count is always ≤ triangles.length. We track the actual
  // draw count via geom.setDrawRange so unused tail entries are ignored.
  const indexBuf = new Uint32Array(triangles.length);
  const indexAttr = new THREE.BufferAttribute(indexBuf, 1);
  indexAttr.setUsage(THREE.DynamicDrawUsage);
  geom.setIndex(indexAttr);
  let drawCount = filterTriangles(indexBuf);
  indexAttr.needsUpdate = true;
  geom.setDrawRange(0, drawCount);
  geom.computeBoundingSphere();

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uExaggeration: { value: 0.05 },
      uSunDir: { value: new THREE.Vector3(0.6, 0.5, 0.8).normalize() },
    },
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "hayba-sim-mesh";

  const update = (
    cellPositions: ArrayLike<number>,
    cellElevation: ArrayLike<number>,
    cellPlateIds: ArrayLike<number>,
  ): void => {
    if (cellElevation.length !== n) {
      console.warn(`[simMesh] n_cells changed (${n} → ${cellElevation.length}); rebuild required`);
      return;
    }
    // Vertex positions + elevations: always update.
    const pos = posBuf.array as Float32Array;
    for (let i = 0; i < cellPositions.length; i++) pos[i] = cellPositions[i];
    posBuf.needsUpdate = true;
    const el = elevBuf.array as Float32Array;
    for (let i = 0; i < n; i++) el[i] = cellElevation[i];
    elevBuf.needsUpdate = true;

    // Plate ownership: only rebuild the filtered index buffer if it
    // actually changed (rare event — subduction transfers happen at a
    // few cells per step at most).
    let plateChanged = false;
    for (let i = 0; i < n; i++) {
      const newPid = cellPlateIds[i] | 0;
      if (plateIdCache[i] !== newPid) {
        plateIdCache[i] = newPid;
        plateChanged = true;
      }
    }
    if (plateChanged) {
      const newCount = filterTriangles(indexBuf);
      indexAttr.needsUpdate = true;
      geom.setDrawRange(0, newCount);
      drawCount = newCount;
    }
  };

  const dispose = (): void => {
    geom.dispose();
    mat.dispose();
  };

  return { object: mesh, update, dispose };
}
