import * as THREE from "three";

import temperateUrl from "../assets/satmaps/temperate.png";
import tropicalUrl  from "../assets/satmaps/tropical.png";
import aridUrl      from "../assets/satmaps/arid.png";
import alpineUrl    from "../assets/satmaps/alpine.png";
import tundraUrl    from "../assets/satmaps/tundra.png";
import oceanicUrl   from "../assets/satmaps/oceanic.png";

export type SatMapName = "temperate" | "tropical" | "arid" | "alpine" | "tundra" | "oceanic";

const URLS: Record<SatMapName, string> = {
  temperate: temperateUrl,
  tropical:  tropicalUrl,
  arid:      aridUrl,
  alpine:    alpineUrl,
  tundra:    tundraUrl,
  oceanic:   oceanicUrl,
};

const cache = new Map<SatMapName, THREE.Texture>();

export function loadSatMap(name: SatMapName): THREE.Texture {
  const cached = cache.get(name);
  if (cached) return cached;
  const tex = new THREE.TextureLoader().load(URLS[name]);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(name, tex);
  return tex;
}

export const SATMAP_NAMES: SatMapName[] = ["temperate", "tropical", "arid", "alpine", "tundra", "oceanic"];
