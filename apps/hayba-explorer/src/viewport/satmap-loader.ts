import * as THREE from "three";

/**
 * SatMap loader — dynamically picks up every PNG in `apps/hayba-explorer/src/
 * assets/satmaps/` via Vite's import.meta.glob, plus the satmaps.json
 * metadata sidecar that tags each SatMap with its Köppen climate codes and
 * geology class.
 *
 * The renderer reads this catalog at startup; per-cell SatMap selection
 * (sim-state driven) happens at sample time via the metadata.
 */

// Pull every SatMap PNG. Vite resolves these at build time as URLs.
const PNG_MODULES = import.meta.glob<{ default: string }>("../assets/satmaps/*.png", { eager: true });

// Pull the metadata sidecar (committed alongside the PNGs).
import metaJson from "../assets/satmaps/satmaps.json";

export interface SatMapClimate {
  class: string;          // e.g. "tropical_wet" / "arid_cold" / "polar_icecap"
  koppen: string[];       // ["Af", "Am"]
  lat_band?: number[];    // [0..4]
}

export interface SatMapGeology {
  class: string;          // "sedimentary_basin", "active_orogeny", ...
  crust?: "continental" | "oceanic";
  tectonic?: "stable" | "convergent" | "divergent" | "subduction";
  lithology?: string;
  surface?: string;
  modifier?: string;
}

export interface SatMapMetadata {
  region: string;
  climate: SatMapClimate;
  geology: SatMapGeology;
  elevation_band_m: (number | null)[];
}

const URLS: Record<string, string> = {};
for (const [path, mod] of Object.entries(PNG_MODULES)) {
  const name = path.split("/").pop()!.replace(/\.png$/, "");
  URLS[name] = mod.default;
}

export const METADATA: Record<string, SatMapMetadata> = metaJson as unknown as Record<string, SatMapMetadata>;

/** All SatMaps that have both a PNG on disk AND metadata in satmaps.json. */
export const SATMAP_NAMES: string[] = Object.keys(URLS)
  .filter((n) => METADATA[n] !== undefined)
  .sort();

/** Climate-family grouping for the Settings dropdown. */
export const SATMAP_FAMILIES: Record<string, string[]> = (() => {
  const groups: Record<string, string[]> = {};
  for (const name of SATMAP_NAMES) {
    const family = METADATA[name].climate.class;
    (groups[family] ??= []).push(name);
  }
  return groups;
})();

const cache = new Map<string, THREE.Texture>();

export function loadSatMap(name: string): THREE.Texture {
  const cached = cache.get(name);
  if (cached) return cached;
  const url = URLS[name];
  if (!url) throw new Error(`SatMap '${name}' not found — expected file apps/hayba-explorer/src/assets/satmaps/${name}.png`);
  const tex = new THREE.TextureLoader().load(url);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(name, tex);
  return tex;
}

/** Convenience export for callers that want a typed alias (the union is open). */
export type SatMapName = string;

/** Resolved PNG URL for a SatMap (for <img> thumbnails in the picker). */
export function satMapUrl(name: string): string | undefined {
  return URLS[name];
}

/** Biome slot order — MUST match climate.rs BIOME_* ids and mesh uBiome0..9. */
export const BIOME_SLOTS: { index: number; label: string; defaultName: string }[] = [
  { index: 0, label: "Tropical rainforest", defaultName: "tropical_wet_basin" },
  { index: 1, label: "Tropical savanna",    defaultName: "tropical_dry_craton" },
  { index: 2, label: "Hot desert",          defaultName: "arid_hot_dunes" },
  { index: 3, label: "Temperate rainforest",defaultName: "temperate_humid_coast" },
  { index: 4, label: "Temperate forest",    defaultName: "temperate_humid_orogeny" },
  { index: 5, label: "Woodland / shrub",    defaultName: "temperate_med" },
  { index: 6, label: "Grassland / steppe",  defaultName: "continental_steppe" },
  { index: 7, label: "Boreal / taiga",      defaultName: "continental_shield" },
  { index: 8, label: "Tundra",              defaultName: "polar_tundra" },
  { index: 9, label: "Ice cap",             defaultName: "polar_icecap" },
];
