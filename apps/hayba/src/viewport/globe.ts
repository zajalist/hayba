import * as THREE from "three";
import type { WizardDraft } from "../wizard/state";
import type { PlanetSnapshot } from "../App";

const OCEAN_COLOR: [number, number, number] = [0.13, 0.21, 0.34]; // deep slate-blue

export interface GlobeHandle {
  object: THREE.Object3D;
  /** Recolor in place from a wizard draft (paint preview path). */
  recolorFromDraft(draft: WizardDraft, nCells: number): void;
  /** Recolor in place from a baked snapshot (post-bake path). */
  recolorFromSnapshot(snap: PlanetSnapshot): void;
}

/**
 * Build a point-cloud globe over a fixed cell-position buffer. Subsequent
 * recolor calls mutate the color attribute in place without rebuilding
 * geometry — fast enough to drive per-pointer-event paint feedback.
 */
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
      // Reset all to ocean, then stamp painted cells per plate's color.
      for (let i = 0; i < nCells; i++) {
        colors[3 * i + 0] = OCEAN_COLOR[0];
        colors[3 * i + 1] = OCEAN_COLOR[1];
        colors[3 * i + 2] = OCEAN_COLOR[2];
      }
      for (const plate of draft.plates) {
        if (!plate.continental) continue;
        const r = plate.color_rgb[0] / 255;
        const g = plate.color_rgb[1] / 255;
        const b = plate.color_rgb[2] / 255;
        for (const cellId of plate.cell_ids) {
          if (cellId < 0 || cellId >= nCells) continue;
          colors[3 * cellId + 0] = r;
          colors[3 * cellId + 1] = g;
          colors[3 * cellId + 2] = b;
        }
      }
      colorAttr.needsUpdate = true;
    },
    recolorFromSnapshot(snap) {
      const continentAccent: [number, number, number] = [0.71, 0.42, 0.11];
      for (let i = 0; i < snap.n_cells; i++) {
        const c = snap.cell_continental[i] === 1 ? continentAccent : OCEAN_COLOR;
        colors[3 * i + 0] = c[0];
        colors[3 * i + 1] = c[1];
        colors[3 * i + 2] = c[2];
      }
      colorAttr.needsUpdate = true;
    },
  };
}
