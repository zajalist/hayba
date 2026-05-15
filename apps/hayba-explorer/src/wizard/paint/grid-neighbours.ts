export interface GridAdjacency {
  /** Unit-sphere position per cell, indexed by cell id. */
  positions: ReadonlyArray<readonly [number, number, number]> | Float32Array;
  /** Neighbour cell ids per cell. */
  neighbours: ReadonlyArray<ReadonlyArray<number>>;
}

export interface AffectedCell {
  cellId: number;
  /** Angular distance in radians from the hit point. */
  distRad: number;
}

export interface CellsInRadiusArgs extends GridAdjacency {
  seedCellId: number;
  hit: readonly [number, number, number];
  radiusRad: number;
}

function getPos(
  positions: CellsInRadiusArgs["positions"],
  id: number,
): [number, number, number] {
  if (positions instanceof Float32Array) {
    return [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]];
  }
  return positions[id] as [number, number, number];
}

function angularDist(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Both are unit vectors; clamp guards floating-point overshoot.
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

/** BFS from `seedCellId` over the adjacency graph; return every cell whose
 *  angular distance to `hit` is < `radiusRad`. */
export function cellsInRadius(args: CellsInRadiusArgs): AffectedCell[] {
  const { positions, neighbours, seedCellId, hit, radiusRad } = args;
  const visited = new Set<number>();
  const out: AffectedCell[] = [];
  const queue: number[] = [seedCellId];
  visited.add(seedCellId);

  while (queue.length > 0) {
    const id = queue.shift()!;
    const pos = getPos(positions, id);
    const d = angularDist(pos, hit);
    if (d < radiusRad) {
      out.push({ cellId: id, distRad: d });
      for (const nb of neighbours[id]) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      }
    }
  }
  return out;
}
