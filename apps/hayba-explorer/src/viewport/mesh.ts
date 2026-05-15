import * as THREE from "three";
import type { PlanetSnapshot } from "../App";
import { loadSatMap, SATMAP_NAMES, type SatMapName } from "./satmap-loader";
import { VERTEX_SHADER, FRAGMENT_SHADER } from "./shaders/planet.glsl";

export interface GlobeMeshHandle {
  object: THREE.Mesh;
  updateFromSnapshot(snap: PlanetSnapshot): void;
  setSatMap(name: SatMapName): void;
  /** Reassign the SatMap for one biome slot (0..9). */
  setBiomeSatMap(biomeIndex: number, name: SatMapName): void;
  setExaggeration(x: number): void;
  setShowPlateOutlines(v: boolean): void;
  setShowBoundaryGlow(v: boolean): void;
  /** Debug map mode: 0 final · 1 temp · 2 moisture · 3 biome · 4 elev · 5 slope · 6 ice · 7 ocean */
  setMapMode(n: number): void;
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

  // WebGL caps vertex attributes at 16. The 9 climate fields are PACKED
  // into 3 vec4 attributes (3 slots, not 9) to stay under the limit:
  //   aClim0 = (biome, temperature, precip, insolation)
  //   aClim1 = (baseTemp, distToOcean, currentDt, orographic)
  //   aClim2 = (continentalDry, _, _, _)
  const clim0 = new Float32Array(n * 4);
  const clim1 = new Float32Array(n * 4);
  const clim2 = new Float32Array(n * 4);
  geom.setAttribute("aClim0", new THREE.BufferAttribute(clim0, 4));
  geom.setAttribute("aClim1", new THREE.BufferAttribute(clim1, 4));
  geom.setAttribute("aClim2", new THREE.BufferAttribute(clim2, 4));

  // Default to a temperate/humid SatMap if available, otherwise the first
  // SatMap discovered in the library. App.tsx calls setSatMap() immediately
  // after construction so this is just a sane starting point.
  const defaultSatMap: SatMapName =
    SATMAP_NAMES.includes("arid_hot_dunes") ? "arid_hot_dunes" :
    SATMAP_NAMES[0];
  const satTex = loadSatMap(defaultSatMap);

  // Pick a SatMap for each climate zone — falls back to the user-selected
  // default if the canonical one isn't available.
  const pick = (preferred: string[], fallback: string): THREE.Texture => {
    for (const name of preferred) if (SATMAP_NAMES.includes(name)) return loadSatMap(name);
    return loadSatMap(SATMAP_NAMES.includes(fallback) ? fallback : SATMAP_NAMES[0]);
  };

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uSatMap:            { value: satTex },                       // user override
      uBiome0: { value: pick(["tropical_wet_basin","tropical_wet_orogeny"], "tropical_wet_basin") },
      uBiome1: { value: pick(["tropical_dry_craton","tropical_dry_rift"], "tropical_dry_craton") },
      uBiome2: { value: pick(["arid_hot_dunes","arid_hot_craton"], "arid_hot_dunes") },
      uBiome3: { value: pick(["temperate_humid_coast"], "temperate_humid_coast") },
      uBiome4: { value: pick(["temperate_humid_orogeny","temperate_humid_old_mountain"], "temperate_humid_orogeny") },
      uBiome5: { value: pick(["temperate_med"], "temperate_med") },
      uBiome6: { value: pick(["continental_steppe","arid_cold_steppe"], "continental_steppe") },
      uBiome7: { value: pick(["continental_shield"], "continental_shield") },
      uBiome8: { value: pick(["polar_tundra"], "polar_tundra") },
      uBiome9: { value: pick(["polar_icecap"], "polar_icecap") },
      uSatMapRock: { value: pick(["arid_hot_orogeny","continental_orogeny"], "continental_orogeny") },
      uClimateBlend:      { value: 1.0 },                          // 1.0 = auto, 0.0 = single override
      uExaggeration:      { value: 1.0 },
      uSunDir:            { value: new THREE.Vector3(0.6, 0.5, 0.8).normalize() },
      uAmbient:           { value: 0.32 },
      uRimColor:          { value: new THREE.Color("#DED4C3") },
      uOceanColor:        { value: new THREE.Color("#2a6fa8") },
      uShowPlateOutlines: { value: 1.0 },
      uShowBoundaryGlow:  { value: 1.0 },
      uMapMode:           { value: 0.0 },
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
    const cd = snap.climate_debug;
    const has = cd.insolation.length === n;
    const bm = snap.cell_biome, tp = snap.cell_temperature, pr = snap.cell_precip;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      clim0[j]     = bm[i];
      clim0[j + 1] = tp[i];
      clim0[j + 2] = pr[i];
      clim0[j + 3] = has ? cd.insolation[i]   : 0;
      clim1[j]     = has ? cd.base_temp[i]     : 0;
      clim1[j + 1] = has ? cd.dist_to_ocean[i] : 0;
      clim1[j + 2] = has ? cd.current_dt[i]    : 0;
      clim1[j + 3] = has ? cd.orographic[i]    : 0;
      clim2[j]     = has ? cd.continental_dry[i] : 0;
    }
    for (const name of attrNames) {
      (geom.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
    }
    (geom.getAttribute("aClim0") as THREE.BufferAttribute).needsUpdate = true;
    (geom.getAttribute("aClim1") as THREE.BufferAttribute).needsUpdate = true;
    (geom.getAttribute("aClim2") as THREE.BufferAttribute).needsUpdate = true;
  };
  updateFromSnapshot(initialSnap);

  return {
    object: mesh,
    updateFromSnapshot,
    setSatMap: (name) => { mat.uniforms.uSatMap.value = loadSatMap(name); },
    setBiomeSatMap: (biomeIndex, name) => {
      const key = "uBiome" + biomeIndex;
      if (mat.uniforms[key]) mat.uniforms[key].value = loadSatMap(name);
    },
    setExaggeration: (x) => { mat.uniforms.uExaggeration.value = x; },
    setShowPlateOutlines: (v) => { mat.uniforms.uShowPlateOutlines.value = v ? 1.0 : 0.0; },
    setShowBoundaryGlow:  (v) => { mat.uniforms.uShowBoundaryGlow.value  = v ? 1.0 : 0.0; },
    setMapMode: (n) => { mat.uniforms.uMapMode.value = n; },
    dispose: () => { geom.dispose(); mat.dispose(); },
  };
}
