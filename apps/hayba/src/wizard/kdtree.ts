// Tiny 3D kd-tree for nearest-cell lookups during continent painting.
// Build is O(n log n), nearest-neighbour query is O(log n) expected.
//
// We don't pull a dependency — peels gives us up to ~164k points (d=128),
// well within the comfortable range for a hand-rolled tree.

interface Node {
  /** Index into the original positions array. */
  idx: number;
  /** Splitting axis (0=x, 1=y, 2=z). */
  axis: number;
  left: Node | null;
  right: Node | null;
}

export interface KdTree {
  /** Flat positions [x0,y0,z0,x1,y1,z1,...]. Held by reference. */
  positions: Float32Array;
  root: Node | null;
}

export function buildCellKdTree(positions: Float32Array): KdTree {
  const n = positions.length / 3;
  if (n === 0) return { positions, root: null };

  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;

  function build(lo: number, hi: number, depth: number): Node | null {
    if (lo >= hi) return null;
    const axis = depth % 3;
    const mid = (lo + hi) >>> 1;
    nthElement(indices, positions, lo, hi, mid, axis);
    const left = build(lo, mid, depth + 1);
    const right = build(mid + 1, hi, depth + 1);
    return { idx: indices[mid], axis, left, right };
  }
  const root = build(0, n, 0);
  return { positions, root };
}

// In-place "nth element" — partial sort that puts the median at `mid` and
// partitions other indices around it. Iterative quickselect.
function nthElement(indices: Uint32Array, positions: Float32Array, lo: number, hi: number, target: number, axis: number) {
  while (lo < hi - 1) {
    const pivotIdx = (lo + hi) >>> 1;
    const pivotVal = positions[indices[pivotIdx] * 3 + axis];
    // Move pivot to end.
    swap(indices, pivotIdx, hi - 1);
    let store = lo;
    for (let i = lo; i < hi - 1; i++) {
      if (positions[indices[i] * 3 + axis] < pivotVal) {
        swap(indices, i, store);
        store++;
      }
    }
    swap(indices, store, hi - 1);
    if (store === target) return;
    if (target < store) hi = store;
    else lo = store + 1;
  }
}

function swap(arr: Uint32Array, i: number, j: number) {
  const t = arr[i];
  arr[i] = arr[j];
  arr[j] = t;
}

export function nearestCell(tree: KdTree, x: number, y: number, z: number): number {
  if (!tree.root) return -1;
  const best = { idx: -1, dist2: Infinity };
  walk(tree.root, tree.positions, x, y, z, best);
  return best.idx;
}

/**
 * All cells within `radius` (chord distance on the unit sphere) of (x,y,z).
 * For an angular radius `α`, pass `chord = 2 * sin(α / 2)`. The output array
 * is unsorted; duplicates are not produced.
 */
export function cellsWithinRadius(
  tree: KdTree,
  x: number, y: number, z: number,
  radius: number,
  out: number[] = [],
): number[] {
  if (!tree.root) return out;
  const r2 = radius * radius;
  walkRadius(tree.root, tree.positions, x, y, z, r2, out);
  return out;
}

function walkRadius(
  node: Node, pos: Float32Array,
  x: number, y: number, z: number,
  r2: number, out: number[],
) {
  const ix = node.idx * 3;
  const dx = pos[ix] - x;
  const dy = pos[ix + 1] - y;
  const dz = pos[ix + 2] - z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 <= r2) out.push(node.idx);
  const q = node.axis === 0 ? x : node.axis === 1 ? y : z;
  const v = pos[ix + node.axis];
  const planeDist = q - v;
  const planeDist2 = planeDist * planeDist;
  // Always descend the near side; descend the far side only if the splitting
  // plane is within radius of the query.
  if (planeDist < 0) {
    if (node.left)  walkRadius(node.left,  pos, x, y, z, r2, out);
    if (planeDist2 <= r2 && node.right) walkRadius(node.right, pos, x, y, z, r2, out);
  } else {
    if (node.right) walkRadius(node.right, pos, x, y, z, r2, out);
    if (planeDist2 <= r2 && node.left)  walkRadius(node.left,  pos, x, y, z, r2, out);
  }
}

function walk(node: Node, pos: Float32Array, x: number, y: number, z: number, best: { idx: number; dist2: number }) {
  const ix = node.idx * 3;
  const dx = pos[ix] - x;
  const dy = pos[ix + 1] - y;
  const dz = pos[ix + 2] - z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < best.dist2) {
    best.dist2 = d2;
    best.idx = node.idx;
  }
  const q = node.axis === 0 ? x : node.axis === 1 ? y : z;
  const v = pos[ix + node.axis];
  const goLeft = q < v;
  const near = goLeft ? node.left : node.right;
  const far = goLeft ? node.right : node.left;
  if (near) walk(near, pos, x, y, z, best);
  const planeDist = q - v;
  if (planeDist * planeDist < best.dist2 && far) {
    walk(far, pos, x, y, z, best);
  }
}
