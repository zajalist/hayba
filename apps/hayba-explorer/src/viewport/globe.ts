import * as THREE from "three";
import type { WizardDraft, BoundaryType } from "../wizard/state";
import type { PlanetSnapshot } from "../App";
import type { BoundaryModel, BoundaryAssignments } from "../wizard/boundary-model";

export interface BoundaryRender {
  /** Cells highlighted neutrally (TE pink) — every boundary cell in the partition. */
  allBoundaryCells: number[];
  /** Cells the user is currently hovering over (the focused boundary pair). */
  hoverCells?: number[];
  /** Per-pair assignments — cells colored convergent/divergent. */
  assigned: Array<{ cells: number[]; type: BoundaryType }>;
}

// Wizard-time color set. Continental = filled accent, ocean = deep slate,
// preview = soft tinted accent for the brush hover ring.
const OCEAN_COLOR:     [number, number, number] = [0.13, 0.21, 0.34];
const CONTINENT_COLOR: [number, number, number] = [0.71, 0.42, 0.11]; // #B56A1D
const PREVIEW_COLOR_PAINT: [number, number, number] = [0.50, 0.34, 0.18]; // muted accent
const PREVIEW_COLOR_ERASE: [number, number, number] = [0.65, 0.20, 0.20]; // muted red
// Matches TE's BOUNDARY_COLOR exactly — keeps the visual signature of the
// original tectonic-explorer for cells that sit on a plate boundary.
const BOUNDARY_COLOR:  [number, number, number] = [0.80, 0.20, 0.50];
// Distinct hues for assigned boundary types — green = converging, blue = diverging.
const BOUNDARY_CONVERGENT_COLOR: [number, number, number] = [0.30, 0.75, 0.50];
const BOUNDARY_DIVERGENT_COLOR:  [number, number, number] = [0.35, 0.60, 0.95];
const BOUNDARY_HOVER_COLOR:      [number, number, number] = [0.98, 0.85, 0.30];

export interface GlobeHandle {
  object: THREE.Object3D;
  /** Color cells from the user's draft + the optional preview set. */
  recolorFromDraft(
    draft: WizardDraft,
    nCells: number,
    previewCells?: Iterable<number>,
    previewMode?: "paint" | "erase",
    boundary?: BoundaryRender,
  ): void;
  /** Color cells by the baked snapshot's per-plate colors (with continental cues). */
  recolorFromSnapshot(
    snap: PlanetSnapshot,
    palette: ReadonlyArray<[number, number, number]>,
    boundary?: { model: BoundaryModel; assignments: BoundaryAssignments },
  ): void;
  /** TECT-PLAY: paint by raw plate-id buffer (one byte per cell, 0 = no plate).
   *  Used by the wizard-mode Play loop so the user can watch plates drift on
   *  the painted globe without needing a full PlanetSnapshot from the bake. */
  recolorFromPlateIds(
    plateIds: Uint8Array | number[],
    palette: ReadonlyArray<[number, number, number]>,
  ): void;
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
    recolorFromDraft(draft, nCells, previewCells, previewMode = "paint") {
      for (let i = 0; i < nCells; i++) paintCell(i, OCEAN_COLOR);
      // For paint preview: stamp preview first so painted cells overlay it.
      // For erase preview: stamp painted cells first, then OVERLAY red preview
      //   so the user sees which painted cells will go away.
      if (previewMode === "paint") {
        if (previewCells) {
          for (const id of previewCells) {
            if (id >= 0 && id < nCells) paintCell(id, PREVIEW_COLOR_PAINT);
          }
        }
        for (const id of draft.continental_cells) {
          if (id >= 0 && id < nCells) paintCell(id, CONTINENT_COLOR);
        }
      } else {
        for (const id of draft.continental_cells) {
          if (id >= 0 && id < nCells) paintCell(id, CONTINENT_COLOR);
        }
        if (previewCells) {
          for (const id of previewCells) {
            if (id >= 0 && id < nCells) paintCell(id, PREVIEW_COLOR_ERASE);
          }
        }
      }
      colorAttr.needsUpdate = true;
    },
    recolorFromSnapshot(snap, palette, boundary) {
      for (let i = 0; i < snap.n_cells; i++) {
        if (snap.cell_is_boundary && snap.cell_is_boundary[i] === 1) {
          // Single source of truth — the BoundaryModel owns the cell→pair
          // mapping (set once when the snapshot lands). No inline scans.
          const t = boundary ? boundary.model.assignmentForCell(boundary.assignments, i) : undefined;
          if (t === "convergent")      paintCell(i, BOUNDARY_CONVERGENT_COLOR);
          else if (t === "divergent")  paintCell(i, BOUNDARY_DIVERGENT_COLOR);
          else                         paintCell(i, BOUNDARY_COLOR);
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
      void BOUNDARY_HOVER_COLOR;
      colorAttr.needsUpdate = true;
    },
    recolorFromPlateIds(plateIds, palette) {
      // Plate ids are 1-based in the Rust sim; 0 = unassigned cell (e.g.
      // freshly subducted). Unassigned cells paint as ocean for legibility;
      // every other cell takes its plate's palette colour.
      const len = Math.min(plateIds.length, n);
      for (let i = 0; i < len; i++) {
        const pid = plateIds[i];
        if (pid <= 0) {
          paintCell(i, OCEAN_COLOR);
          continue;
        }
        const c = palette[(pid - 1) % palette.length] ?? CONTINENT_COLOR;
        paintCell(i, c);
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
