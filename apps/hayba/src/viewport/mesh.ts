import * as THREE from "three";
import type { PlanetSnapshot } from "../App";
import { loadSatMap, type SatMapName } from "./satmap-loader";
import { VERTEX_SHADER, FRAGMENT_SHADER } from "./shaders/planet.glsl";

export interface GlobeMeshHandle {
  object: THREE.Mesh;
  updateFromSnapshot(snap: PlanetSnapshot): void;
  setSatMap(name: SatMapName): void;
  setExaggeration(x: number): void;
  setShowPlateOutlines(v: boolean): void;
  setShowBoundaryGlow(v: boolean): void;
  dispose(): void;
}

/**
 * Build a triangulated planet mesh from an initial snapshot + the icosphere
 * triangle index list (fetched separately via the `get_grid_triangles`
 * Tauri command). Per-vertex attributes are populated from the snapshot and
 * can be refreshed every step via `updateFromSnapshot`.
 */
export function buildGlobeMesh(
  initialSnap: PlanetSnapshot,
  triangles: Uint32Array,
): GlobeMeshHandle {
  const n = initialSnap.n_cells;

  const positions = new Float32Array(initialSnap.cell_positions);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(triangles, 1));
  geom.computeBoundingSphere();

  const attrNames = [
    "elevation", "slope", "plateId", "continental", "isBoundary",
    "collisionKind", "subductionProgress", "orogenicUplift",
    "volcanicIntensity", "morAgeSteps", "crustAge",
  ] as const;

  const attrs: Record<string, Float32Array> = {};
  for (const name of attrNames) {
    const buf = new Float32Array(n);
    attrs[name] = buf;
    geom.setAttribute(name, new THREE.BufferAttribute(buf, 1));
  }

  const satTex = loadSatMap("temperate");
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uSatMap:            { value: satTex },
      uExaggeration:      { value: 1.0 },
      uSunDir:            { value: new THREE.Vector3(0.6, 0.5, 0.8).normalize() },
      uAmbient:           { value: 0.28 },
      uRimColor:          { value: new THREE.Color("#DED4C3") },
      uOceanColor:        { value: new THREE.Color("#1b3a55") },
      uShowPlateOutlines: { value: 1.0 },
      uShowBoundaryGlow:  { value: 1.0 },
    },
    // `derivatives` (dFdx/dFdy) is always available in WebGL2 — no extension needed.
  });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "hayba-globe-mesh";

  const updateFromSnapshot = (snap: PlanetSnapshot) => {
    if (snap.n_cells !== n) {
      console.warn("[mesh] snapshot n_cells changed — rebuild required");
      return;
    }
    attrs.elevation.set(snap.cell_elevation);
    attrs.slope.set(snap.cell_slope);
    // plateId can be -1 for unassigned; clamp to 0 for the shader's fwidth() pass
    for (let i = 0; i < n; i++) {
      attrs.plateId[i] = Math.max(snap.cell_plate_ids[i], 0);
    }
    attrs.continental.set(snap.cell_continental);
    attrs.isBoundary.set(snap.cell_is_boundary);
    attrs.collisionKind.set(snap.cell_collision_kind);
    attrs.subductionProgress.set(snap.cell_subduction_progress);
    attrs.orogenicUplift.set(snap.cell_orogenic_uplift);
    attrs.volcanicIntensity.set(snap.cell_volcanic_intensity);
    attrs.morAgeSteps.set(snap.cell_mor_age_steps);
    attrs.crustAge.set(snap.cell_age_ma);
    for (const name of attrNames) {
      (geom.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
  };
  updateFromSnapshot(initialSnap);

  return {
    object: mesh,
    updateFromSnapshot,
    setSatMap: (name) => { mat.uniforms.uSatMap.value = loadSatMap(name); },
    setExaggeration: (x) => { mat.uniforms.uExaggeration.value = x; },
    setShowPlateOutlines: (v) => { mat.uniforms.uShowPlateOutlines.value = v ? 1.0 : 0.0; },
    setShowBoundaryGlow:  (v) => { mat.uniforms.uShowBoundaryGlow.value  = v ? 1.0 : 0.0; },
    dispose: () => { geom.dispose(); mat.dispose(); },
  };
}
