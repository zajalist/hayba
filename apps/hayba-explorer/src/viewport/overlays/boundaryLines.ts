// BoundaryLines — TE-style pink seam overlay drawn ALONG the boundary
// between adjacent cells of different plates (not cross-stitched between
// cell centers — that produced a zigzag with stray "spurs" pointing into
// neighbouring cells).
//
// Algorithm (along-seam, per triangle):
//   Each triangle in the icosphere has 3 corner cells. Classify by plate:
//     - all 3 same   → no segment (triangle is interior to a plate)
//     - 2 same + 1 different → ONE segment crossing this triangle, from
//       the midpoint of one cross-plate edge to the midpoint of the other.
//     - 3 different   → triple junction; 3 segments from each cross-plate
//       edge midpoint to the triangle centroid (skipped for now — rare
//       and visually messy; we draw the three perimeter midpoints joined
//       pairwise as approximation).
//
// Endpoints are midpoints of TWO cell positions each, projected back onto
// `RADIUS` so the seam sits on the sphere.
//
// Coloring per segment:
//   - none        → BOUNDARY_PINK
//   - convergent  → red
//   - divergent   → blue

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
  /** Per-tick fast path: stream new positions; if plate ownership has
   *  changed since the last call, also rebuild the segment topology so
   *  newly-cross-plate triangles emit segments and newly-mono-plate
   *  triangles drop them (without this, ghost-loop islands appear at
   *  cells that transferred plates). */
  updatePositions: (
    cellPositions: ArrayLike<number>,
    cellPlateIds: ArrayLike<number>,
    assignments: BoundaryAssignments,
  ) => void;
  dispose: () => void;
}

/** Each segment's two endpoints are midpoints of cell pairs. We cache the
 *  four cell indices (a1, b1, a2, b2) per segment so the per-tick fast path
 *  can re-stream the position buffer from updated cell positions. */
type SegmentEndpoints = Int32Array;

export function buildBoundaryLines(triangles: Uint32Array): BoundaryLinesHandle {
  const geo = new THREE.BufferGeometry();
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    depthTest: true,
    linewidth: 1.5,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.name = "hayba-boundary-lines";
  lines.renderOrder = 5;
  lines.visible = false;

  let segmentEndpoints: SegmentEndpoints = new Int32Array(0);
  /** Last seen plate-id assignment. Used to detect ownership changes per
   *  tick and trigger a segment-topology rebuild (the segment list is
   *  determined by which triangles span multiple plates — that changes
   *  whenever cells transfer plates). */
  let lastPlateIds: Int32Array = new Int32Array(0);
  /** Cached assignments → rebuild can re-color without an external arg. */
  let lastAssignments: BoundaryAssignments = {} as BoundaryAssignments;

  /** Midpoint of two unit-sphere positions, renormalised and pushed to RADIUS. */
  const midOnSphere = (
    cells: ArrayLike<number>, a: number, b: number,
    out: [number, number, number],
  ): void => {
    let x = cells[a * 3 + 0] + cells[b * 3 + 0];
    let y = cells[a * 3 + 1] + cells[b * 3 + 1];
    let z = cells[a * 3 + 2] + cells[b * 3 + 2];
    const r = Math.hypot(x, y, z) || 1;
    const s = RADIUS / r;
    out[0] = x * s; out[1] = y * s; out[2] = z * s;
  };

  /** Full segment-topology rebuild. Walks every triangle, classifies it
   *  by the plate-ids of its 3 vertices, and emits segments where 2+
   *  plates touch. Cached assignments + plate-ids are updated so the
   *  per-tick path can skip rebuilds when nothing changed. */
  const rebuildSegments = (
    cellPositions: ArrayLike<number>,
    cellPlateIds: ArrayLike<number>,
    assignments: BoundaryAssignments,
  ): void => {
    const positions: number[] = [];
    const colors:    number[] = [];
    const ends:      number[] = []; // 4 indices per segment: a1, b1, a2, b2
    const cells = cellPositions;
    const plates = cellPlateIds;
    const tri = triangles;
    const m1: [number, number, number] = [0, 0, 0];
    const m2: [number, number, number] = [0, 0, 0];

    const pushSegment = (
      a1: number, b1: number, a2: number, b2: number,
      c: THREE.Color,
    ): void => {
      midOnSphere(cells, a1, b1, m1);
      midOnSphere(cells, a2, b2, m2);
      positions.push(m1[0], m1[1], m1[2], m2[0], m2[1], m2[2]);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      ends.push(a1, b1, a2, b2);
    };

    const colorFor = (pidX: number, pidY: number): THREE.Color => {
      const pk = pairKey(pidX, pidY);
      const t = assignments[pk];
      return t === "convergent" ? COLOR_CONVERGENT
           : t === "divergent"  ? COLOR_DIVERGENT
           : COLOR_PINK;
    };

    // Triangle list is flat: every 3 indices is one triangle (a, b, c).
    for (let t = 0; t + 2 < tri.length; t += 3) {
      const a = tri[t];
      const b = tri[t + 1];
      const c = tri[t + 2];
      const pa = plates[a];
      const pb = plates[b];
      const pc = plates[c];
      if (pa < 0 || pb < 0 || pc < 0) continue;
      if (pa === pb && pb === pc) continue; // interior triangle

      if (pa === pb) {
        // c is the odd one. Cross-plate edges: (a,c) and (b,c).
        pushSegment(a, c, b, c, colorFor(pa, pc));
      } else if (pa === pc) {
        // b is the odd one. Cross-plate edges: (a,b) and (c,b).
        pushSegment(a, b, c, b, colorFor(pa, pb));
      } else if (pb === pc) {
        // a is the odd one. Cross-plate edges: (a,b) and (a,c).
        pushSegment(a, b, a, c, colorFor(pb, pa));
      } else {
        // Triple junction — all 3 different. Draw the three perimeter
        // midpoints joined pairwise (forms a triangle inside the triangle,
        // a reasonable visual stand-in for the three-way Y meeting at the
        // centroid). Uses pair colors per edge.
        pushSegment(a, b, b, c, colorFor(pa, pb));
        pushSegment(b, c, a, c, colorFor(pb, pc));
        pushSegment(a, c, a, b, colorFor(pa, pc));
      }
    }

    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color",    new THREE.Float32BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
    segmentEndpoints = Int32Array.from(ends);
    // Cache plate-id snapshot for per-tick change detection.
    const n = plates.length;
    if (lastPlateIds.length !== n) lastPlateIds = new Int32Array(n);
    for (let i = 0; i < n; i++) lastPlateIds[i] = plates[i] | 0;
    lastAssignments = assignments;
  };

  /** Original bake-time API: rebuild from a full PlanetSnapshot. */
  const update = (snap: PlanetSnapshot, assignments: BoundaryAssignments): void => {
    rebuildSegments(snap.cell_positions, snap.cell_plate_ids, assignments);
  };

  const updatePositions = (
    cellPositions: ArrayLike<number>,
    cellPlateIds: ArrayLike<number>,
    assignments: BoundaryAssignments,
  ): void => {
    // Detect plate-id change since last call. If ANY cell's owner
    // changed, segment topology is stale (some triangles flipped
    // between cross-plate and mono-plate) — full rebuild required.
    let topologyChanged = lastPlateIds.length !== cellPlateIds.length
                       || lastAssignments !== assignments;
    if (!topologyChanged) {
      for (let i = 0; i < cellPlateIds.length; i++) {
        if (lastPlateIds[i] !== (cellPlateIds[i] | 0)) {
          topologyChanged = true;
          break;
        }
      }
    }
    if (topologyChanged) {
      rebuildSegments(cellPositions, cellPlateIds, assignments);
      return;
    }
    // Topology unchanged: cheap stream of endpoint positions.
    if (segmentEndpoints.length === 0) return;
    const posAttr = geo.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    const buf = posAttr.array as Float32Array;
    const m1: [number, number, number] = [0, 0, 0];
    const m2: [number, number, number] = [0, 0, 0];
    const n = segmentEndpoints.length / 4;
    for (let i = 0; i < n; i++) {
      const off = i * 4;
      const a1 = segmentEndpoints[off];
      const b1 = segmentEndpoints[off + 1];
      const a2 = segmentEndpoints[off + 2];
      const b2 = segmentEndpoints[off + 3];
      midOnSphere(cellPositions, a1, b1, m1);
      midOnSphere(cellPositions, a2, b2, m2);
      const o = i * 6;
      buf[o + 0] = m1[0]; buf[o + 1] = m1[1]; buf[o + 2] = m1[2];
      buf[o + 3] = m2[0]; buf[o + 4] = m2[1]; buf[o + 5] = m2[2];
    }
    posAttr.needsUpdate = true;
  };

  return {
    object: lines,
    setVisible: (v: boolean) => { lines.visible = v; },
    update,
    updatePositions,
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}
