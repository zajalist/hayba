// BoundaryModel — the single seam between a baked PlanetSnapshot and the
// boundary-assignment UI. Built once per snapshot. Owns:
//
//   * `cellPairKey[i]`   — for each cell, the canonical pair-key string of
//                          the boundary it sits on, or "" for interior.
//   * `pairs`            — the unique sorted list of pair keys in this snapshot.
//   * `pairMembers[key]` — the (a, b) numeric pair for a given key.
//
// All boundary-related lookups go through this module — there are no
// inline string-key constructions or neighbour scans elsewhere in the
// codebase. Invariants:
//
//   I1. cellPairKey[i] === "" iff snapshot.cell_is_boundary[i] === 0.
//   I2. Every non-empty cellPairKey[i] is present in `pairs`.
//   I3. pairKey(a, b) === pairKey(b, a) always — formatted "min-max".
//   I4. setAssignment / clearAssignment produce new immutable maps;
//       there is no in-place mutation of BoundaryAssignments.

import type { PlanetSnapshot } from "../App";
import type { BoundaryType } from "./state";
import { pairKey } from "./state";

export type BoundaryAssignments = Record<string, BoundaryType>;

export class BoundaryModel {
  readonly cellPairKey: string[];
  readonly pairs: string[];
  readonly pairMembers: Record<string, [number, number]>;

  private constructor(
    cellPairKey: string[],
    pairs: string[],
    pairMembers: Record<string, [number, number]>,
  ) {
    this.cellPairKey = cellPairKey;
    this.pairs = pairs;
    this.pairMembers = pairMembers;
  }

  /**
   * Build the model from a baked PlanetSnapshot. Relies on the Rust-side
   * `cell_neighbor_plate` array (majority neighbour plate id per boundary
   * cell, -1 for interior), so this is O(n_cells).
   */
  static fromSnapshot(snap: PlanetSnapshot): BoundaryModel {
    const n = snap.n_cells;
    const cellPairKey: string[] = new Array(n).fill("");
    const pairSet = new Set<string>();
    const members: Record<string, [number, number]> = {};

    for (let i = 0; i < n; i++) {
      if (!snap.cell_is_boundary[i]) continue;
      const me = snap.cell_plate_ids[i];
      const other = snap.cell_neighbor_plate[i];
      if (me < 0 || other < 0) continue; // edge case — leave as interior
      const key = pairKey(me, other);
      cellPairKey[i] = key;
      if (!pairSet.has(key)) {
        pairSet.add(key);
        members[key] = me < other ? [me, other] : [other, me];
      }
    }

    const pairs = Array.from(pairSet).sort();
    return new BoundaryModel(cellPairKey, pairs, members);
  }

  /** Pair key at a cell, or `null` if the cell is interior. */
  pairKeyForCell(cellIndex: number): string | null {
    if (cellIndex < 0 || cellIndex >= this.cellPairKey.length) return null;
    const k = this.cellPairKey[cellIndex];
    return k === "" ? null : k;
  }

  /** Plate-id pair (sorted ascending) for a given pair key. */
  membersFor(key: string): [number, number] | null {
    return this.pairMembers[key] ?? null;
  }

  /** Is this pair currently assigned? */
  isAssigned(types: BoundaryAssignments, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(types, key);
  }

  /** Type assigned at a cell, or undefined if cell is interior / unassigned. */
  assignmentForCell(types: BoundaryAssignments, cellIndex: number): BoundaryType | undefined {
    const k = this.pairKeyForCell(cellIndex);
    if (!k) return undefined;
    return types[k];
  }
}

/** Pure: set a boundary type by pair key. */
export function setBoundary(
  types: BoundaryAssignments,
  key: string,
  type: BoundaryType,
): BoundaryAssignments {
  return { ...types, [key]: type };
}

/** Pure: clear a boundary assignment. */
export function clearBoundary(
  types: BoundaryAssignments,
  key: string,
): BoundaryAssignments {
  if (!Object.prototype.hasOwnProperty.call(types, key)) return types;
  const next: BoundaryAssignments = { ...types };
  delete next[key];
  return next;
}
