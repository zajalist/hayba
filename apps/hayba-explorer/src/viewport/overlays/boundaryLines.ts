// BoundaryLines — TE-style pink seam overlay drawn between adjacent cells
// that belong to different plates. Lives as a separate THREE.LineSegments
// Object3D so it sits on top of whatever globe is currently displayed
// (point cloud during compose, eroded sphere post-bake). One overlay per
// baked snapshot — rebuild via `update()` when the snapshot or
// assignments change.
//
// Coloring per segment:
//   - none        → BOUNDARY_PINK
//   - convergent  → red
//   - divergent   → blue
//   - transform   → yellow (reserved; current sim only supports convergent
//                   and divergent, but the segment lookup falls back to
//                   pink for any unknown assignment).
//
// Endpoints are pushed slightly off the unit sphere (RADIUS) so the lines
// are not z-fought into the surface texture. The overlay is drawn after
// the globe (`renderOrder = 5`).

import * as THREE from "three";
import type { PlanetSnapshot } from "../../App";
import type { BoundaryAssignments } from "../../wizard/boundary-model";
import { pairKey } from "../../wizard/state";

const RADIUS = 1.005;
const COLOR_PINK       = new THREE.Color(0.80, 0.20, 0.50);
const COLOR_CONVERGENT = new THREE.Color(0.95, 0.30, 0.30);
const COLOR_DIVERGENT  = new THREE.Color(0.35, 0.60, 0.95);

export interface BoundaryLinesHandle {
  object: THREE.LineSegments;
  setVisible: (v: boolean) => void;
  /** Recompute geometry from the snapshot + per-pair assignments. */
  update: (snap: PlanetSnapshot, assignments: BoundaryAssignments) => void;
  dispose: () => void;
}

export function buildBoundaryLines(adjacency: number[][]): BoundaryLinesHandle {
  const geo = new THREE.BufferGeometry();
  // Start with an empty buffer; the first update() fills it. Vertex-coloured
  // lines so each segment can carry its own (pink / red / blue) tint.
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    depthTest: true,
    linewidth: 1.5, // ignored by most WebGL impls but keeps the intent
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.name = "hayba-boundary-lines";
  lines.renderOrder = 5;
  lines.visible = false;

  const update = (snap: PlanetSnapshot, assignments: BoundaryAssignments): void => {
    const positions: number[] = [];
    const colors:    number[] = [];
    const n = snap.n_cells;
    const seen = new Set<number>(); // encoded edge (min, max) -> min * n + max

    const pushSegment = (a: number, b: number, c: THREE.Color): void => {
      const ax = snap.cell_positions[a * 3 + 0] * RADIUS;
      const ay = snap.cell_positions[a * 3 + 1] * RADIUS;
      const az = snap.cell_positions[a * 3 + 2] * RADIUS;
      const bx = snap.cell_positions[b * 3 + 0] * RADIUS;
      const by = snap.cell_positions[b * 3 + 1] * RADIUS;
      const bz = snap.cell_positions[b * 3 + 2] * RADIUS;
      positions.push(ax, ay, az, bx, by, bz);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };

    for (let i = 0; i < n; i++) {
      if (!snap.cell_is_boundary[i]) continue;
      const pidA = snap.cell_plate_ids[i];
      if (pidA < 0) continue;
      const neighbours = adjacency[i];
      if (!neighbours) continue;
      for (const j of neighbours) {
        if (j <= i) continue; // skip dupes — each unordered edge fires once
        if (!snap.cell_is_boundary[j]) continue;
        const pidB = snap.cell_plate_ids[j];
        if (pidB < 0 || pidB === pidA) continue;
        const key = i * n + j;
        if (seen.has(key)) continue;
        seen.add(key);
        const pk = pairKey(pidA, pidB);
        const t = assignments[pk];
        const c = t === "convergent" ? COLOR_CONVERGENT
                : t === "divergent"  ? COLOR_DIVERGENT
                : COLOR_PINK;
        pushSegment(i, j, c);
      }
    }

    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color",    new THREE.Float32BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
  };

  return {
    object: lines,
    setVisible: (v: boolean) => { lines.visible = v; },
    update,
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}
