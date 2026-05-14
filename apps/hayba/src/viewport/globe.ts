import * as THREE from "three";
import type { WizardDraft } from "../wizard/state";
import type { PlanetSnapshot } from "../App";

// Two-color preview during paint: accent for continental crust, slate for ocean.
const OCEAN_COLOR:     [number, number, number] = [0.13, 0.21, 0.34];
const CONTINENT_COLOR: [number, number, number] = [0.71, 0.42, 0.11]; // #B56A1D

export interface GlobeHandle {
  object: THREE.Object3D;
  /** Color cells by the user's painted continental set (preview during the wizard). */
  recolorFromDraft(draft: WizardDraft, nCells: number): void;
  /** Color cells by the baked snapshot's continental flag (post-bake). */
  recolorFromSnapshot(snap: PlanetSnapshot): void;
}

export function buildGlobe(cellPositions: Float32Array): GlobeHandle {
  const n = cellPositions.length / 3;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[3 * i + 0] = OCEAN_COLOR[0];
    colors[3 * i + 1] = OCEAN_COLOR[1];
    colors[3 * i + 2] = OCEAN_COLOR[2];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(cellPositions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 0.018,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.name = "hayba-globe";

  const colorAttr = geo.getAttribute("color") as THREE.BufferAttribute;

  return {
    object: points,
    recolorFromDraft(draft, nCells) {
      // Reset to ocean.
      for (let i = 0; i < nCells; i++) {
        colors[3 * i + 0] = OCEAN_COLOR[0];
        colors[3 * i + 1] = OCEAN_COLOR[1];
        colors[3 * i + 2] = OCEAN_COLOR[2];
      }
      // Paint continental cells.
      for (const cellId of draft.continental_cells) {
        if (cellId < 0 || cellId >= nCells) continue;
        colors[3 * cellId + 0] = CONTINENT_COLOR[0];
        colors[3 * cellId + 1] = CONTINENT_COLOR[1];
        colors[3 * cellId + 2] = CONTINENT_COLOR[2];
      }
      colorAttr.needsUpdate = true;
    },
    recolorFromSnapshot(snap) {
      for (let i = 0; i < snap.n_cells; i++) {
        const c = snap.cell_continental[i] === 1 ? CONTINENT_COLOR : OCEAN_COLOR;
        colors[3 * i + 0] = c[0];
        colors[3 * i + 1] = c[1];
        colors[3 * i + 2] = c[2];
      }
      colorAttr.needsUpdate = true;
    },
  };
}
