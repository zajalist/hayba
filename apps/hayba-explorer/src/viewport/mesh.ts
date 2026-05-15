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
  /** Per-biome ramp remap. biomeIndex 0..9; min/max in 0..1, bias 0..1 (0.5 = identity). */
  setBiomeRemap(biomeIndex: number, min: number, max: number, bias: number): void;
  setExaggeration(x: number): void;
  setSurfaceBrightness(x: number): void;
  setTextureSmooth(x: number): void;
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

  // WebGL caps vertex attributes at MAX_VERTEX_ATTRIBS (16) and Three.js
  // ShaderMaterial auto-injects position/normal/uv builtins. Per-cell
  // scalars are PACKED into 6 vec4 attributes (6 slots):
  //   aPack0 = (elevation, slope, plateId, continental)
  //   aPack1 = (isBoundary, collisionKind, subductionProgress, orogenicUplift)
  //   aPack2 = (volcanicIntensity, morAgeSteps, crustAge, biome)
  //   aPack3 = (temperature, precip, insolation, baseTemp)
  //   aPack4 = (distToOcean, currentDt, orographic, continentalDry)
  //   aPack5 = (biome, biome2, biomeBlend, _)
  const pack0 = new Float32Array(n * 4);
  const pack1 = new Float32Array(n * 4);
  const pack2 = new Float32Array(n * 4);
  const pack3 = new Float32Array(n * 4);
  const pack4 = new Float32Array(n * 4);
  const pack5 = new Float32Array(n * 4);
  geom.setAttribute("aPack0", new THREE.BufferAttribute(pack0, 4));
  geom.setAttribute("aPack1", new THREE.BufferAttribute(pack1, 4));
  geom.setAttribute("aPack2", new THREE.BufferAttribute(pack2, 4));
  geom.setAttribute("aPack3", new THREE.BufferAttribute(pack3, 4));
  geom.setAttribute("aPack4", new THREE.BufferAttribute(pack4, 4));
  geom.setAttribute("aPack5", new THREE.BufferAttribute(pack5, 4));

  // Cell-stable texture seed (flaw A3): a dedicated vec3 attribute holding
  // an index-derived pseudo-random unit vector per cell. The fragment
  // shader keys its within-biome texture noise on this instead of the
  // world-space normal, so the surface texture rides with the drifting
  // crust instead of crawling. Attribute budget: 3 builtins + 6 vec4
  // (aPack0..5) + 1 vec3 (aSeed) = 10 ≤ 16 — fine.
  const seedBuf = new Float32Array(n * 3);
  geom.setAttribute("aSeed", new THREE.BufferAttribute(seedBuf, 3));

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
      // Per-biome ramp remap (min,max,bias,_). (0,1,0.5,0) = identity.
      uBiomeRemap: { value: Array.from({ length: 10 }, () => new THREE.Vector4(0, 1, 0.5, 0)) },
      uClimateBlend:      { value: 1.0 },                          // 1.0 = auto, 0.0 = single override
      uExaggeration:      { value: 1.0 },
      uSunDir:            { value: new THREE.Vector3(0.6, 0.5, 0.8).normalize() },
      uAmbient:           { value: 0.32 },
      uRimColor:          { value: new THREE.Color("#DED4C3") },
      uOceanColor:        { value: new THREE.Color("#2a6fa8") },
      uShowPlateOutlines: { value: 1.0 },
      uShowBoundaryGlow:  { value: 1.0 },
      uMapMode:           { value: 0.0 },
      uSurfaceBrightness: { value: 1.4 },
      uTextureSmooth:     { value: 0.4 },
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
    const cd = snap.climate_debug;
    const has = cd.insolation.length === n;
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      pack0[j]     = snap.cell_elevation[i];
      pack0[j + 1] = snap.cell_slope[i];
      pack0[j + 2] = Math.max(snap.cell_plate_ids[i], 0); // -1 → 0 for fwidth() pass
      pack0[j + 3] = snap.cell_continental[i];
      pack1[j]     = snap.cell_is_boundary[i];
      pack1[j + 1] = snap.cell_collision_kind[i];
      pack1[j + 2] = snap.cell_subduction_progress[i];
      pack1[j + 3] = snap.cell_orogenic_uplift[i];
      pack2[j]     = snap.cell_volcanic_intensity[i];
      pack2[j + 1] = snap.cell_mor_age_steps[i];
      pack2[j + 2] = snap.cell_age_ma[i];
      pack2[j + 3] = snap.cell_biome[i];
      pack3[j]     = snap.cell_temperature[i];
      pack3[j + 1] = snap.cell_precip[i];
      pack3[j + 2] = has ? cd.insolation[i] : 0;
      pack3[j + 3] = has ? cd.base_temp[i]  : 0;
      pack4[j]     = has ? cd.dist_to_ocean[i]   : 0;
      pack4[j + 1] = has ? cd.current_dt[i]      : 0;
      pack4[j + 2] = has ? cd.orographic[i]      : 0;
      pack4[j + 3] = has ? cd.continental_dry[i] : 0;
      pack5[j]     = snap.cell_biome[i];
      pack5[j + 1] = snap.cell_biome2[i];
      pack5[j + 2] = snap.cell_biome_blend[i];
      pack5[j + 3] = 0;
      seedBuf[i * 3]     = snap.cell_seed[i * 3];
      seedBuf[i * 3 + 1] = snap.cell_seed[i * 3 + 1];
      seedBuf[i * 3 + 2] = snap.cell_seed[i * 3 + 2];
    }
    for (const a of ["aPack0", "aPack1", "aPack2", "aPack3", "aPack4", "aPack5", "aSeed"]) {
      (geom.getAttribute(a) as THREE.BufferAttribute).needsUpdate = true;
    }
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
    setBiomeRemap: (biomeIndex, min, max, bias) => {
      const arr = mat.uniforms.uBiomeRemap?.value as THREE.Vector4[] | undefined;
      if (arr && arr[biomeIndex]) arr[biomeIndex].set(min, max, bias, 0);
    },
    setExaggeration: (x) => { mat.uniforms.uExaggeration.value = x; },
    setShowPlateOutlines: (v) => { mat.uniforms.uShowPlateOutlines.value = v ? 1.0 : 0.0; },
    setShowBoundaryGlow:  (v) => { mat.uniforms.uShowBoundaryGlow.value  = v ? 1.0 : 0.0; },
    setMapMode: (n) => { mat.uniforms.uMapMode.value = n; },
    setSurfaceBrightness: (x) => { mat.uniforms.uSurfaceBrightness.value = x; },
    setTextureSmooth: (x) => { mat.uniforms.uTextureSmooth.value = x; },
    dispose: () => { geom.dispose(); mat.dispose(); },
  };
}
