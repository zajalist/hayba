import * as THREE from "three";
import type { WizardDraft } from "../wizard/state";
import type { PlanetSnapshot } from "../App";

// Wizard-time color set. Continental = filled accent, ocean = deep slate,
// preview = soft tinted accent for the brush hover ring.
const OCEAN_COLOR:     [number, number, number] = [0.13, 0.21, 0.34];
const CONTINENT_COLOR: [number, number, number] = [0.71, 0.42, 0.11]; // #B56A1D
const PREVIEW_COLOR:   [number, number, number] = [0.50, 0.34, 0.18]; // muted accent
// Matches TE's BOUNDARY_COLOR exactly — keeps the visual signature of the
// original tectonic-explorer for cells that sit on a plate boundary.
const BOUNDARY_COLOR:  [number, number, number] = [0.80, 0.20, 0.50];

export interface GlobeHandle {
  object: THREE.Object3D;
  /** Color cells from the user's draft + the optional preview set. */
  recolorFromDraft(draft: WizardDraft, nCells: number, previewCells?: Iterable<number>): void;
  /** Color cells by the baked snapshot's per-plate colors (with continental cues). */
  recolorFromSnapshot(snap: PlanetSnapshot, palette: ReadonlyArray<[number, number, number]>): void;
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

  function paintCell(i: number, c: [number, number, number]) {
    colors[3 * i + 0] = c[0];
    colors[3 * i + 1] = c[1];
    colors[3 * i + 2] = c[2];
  }

  return {
    object: points,
    recolorFromDraft(draft, nCells, previewCells) {
      for (let i = 0; i < nCells; i++) paintCell(i, OCEAN_COLOR);
      // Preview first, so painted cells stamp over the preview if they overlap.
      if (previewCells) {
        for (const id of previewCells) {
          if (id >= 0 && id < nCells) paintCell(id, PREVIEW_COLOR);
        }
      }
      for (const id of draft.continental_cells) {
        if (id >= 0 && id < nCells) paintCell(id, CONTINENT_COLOR);
      }
      colorAttr.needsUpdate = true;
    },
    recolorFromSnapshot(snap, palette) {
      // Continental cells: take the plate's color, slightly desaturated.
      // Oceanic cells: take the plate's color, deeply darkened toward slate.
      // Boundary cells: TE's pink — wins over the plate tint, matching TE.
      for (let i = 0; i < snap.n_cells; i++) {
        if (snap.cell_is_boundary && snap.cell_is_boundary[i] === 1) {
          paintCell(i, BOUNDARY_COLOR);
          continue;
        }
        const pid = snap.cell_plate_ids[i];
        const isCont = snap.cell_continental[i] === 1;
        if (pid < 0) {
          paintCell(i, OCEAN_COLOR);
          continue;
        }
        const base = palette[(pid - 1) % palette.length] ?? CONTINENT_COLOR;
        if (isCont) {
          paintCell(i, base);
        } else {
          paintCell(i, [
            base[0] * 0.25 + OCEAN_COLOR[0] * 0.75,
            base[1] * 0.25 + OCEAN_COLOR[1] * 0.75,
            base[2] * 0.25 + OCEAN_COLOR[2] * 0.75,
          ]);
        }
      }
      colorAttr.needsUpdate = true;
    },
  };
}

/** Hayba plate palette — kept in sync with Rust's `wizard::PALETTE`. */
export const PLATE_PALETTE: ReadonlyArray<[number, number, number]> = [
  [0.71, 0.42, 0.11],
  [0.54, 0.29, 0.54],
  [0.35, 0.23, 0.54],
  [0.23, 0.48, 0.35],
  [0.66, 0.52, 0.23],
  [0.66, 0.23, 0.23],
  [0.23, 0.54, 0.54],
  [0.42, 0.62, 0.86],
];
