import type { NodeReferenceMap } from './knowledge/knowledge-types.js';

export const LAYOUT = {
  ORIGIN_X: 26400,
  ORIGIN_Y: 26100,
  H_SPACING: 300,
  V_SPACING: 125,
  BRANCH_OFFSET: 200,
} as const;

interface InputNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  phase?: string;
}

interface InputEdge {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export interface PositionedNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  position: { X: number; Y: number };
}

const MERGE_TYPES = new Set(['Combine', 'Mixer', 'Mask']);
const EXPORT_TYPES = new Set(['Unreal', 'Mesher', 'LightX', 'TextureBaker', 'Output']);
const LOOKDEV_TYPES = new Set(['TextureBase', 'SatMap', 'SuperColor', 'HSL', 'Tint', 'Snow', 'DirtColor', 'WaterColor', 'ColorErosion', 'Splat']);

function getPhase(node: InputNode, nodeRef?: NodeReferenceMap): string {
  if (node.phase) return node.phase;
  if (nodeRef && nodeRef[node.type]) return nodeRef[node.type].phase_hint;
  // Only infer phase from type sets when nodeRef is provided
  if (nodeRef) {
    if (EXPORT_TYPES.has(node.type)) return 'utility';
    if (LOOKDEV_TYPES.has(node.type)) return 'lookdev';
  }
  return 'character';
}

/**
 * Modified Sugiyama layout algorithm for Gaea terrain graphs.
 *
 * 1. Topological sort (Kahn's algorithm)
 * 2. Layer assignment (longest-path from sources)
 * 3. Crossing minimization (barycenter heuristic, 2 passes)
 * 4. Position assignment (Gaea conventions)
 */
export function layoutGraph(
  nodes: InputNode[],
  edges: InputEdge[],
  nodeRef?: NodeReferenceMap,
): PositionedNode[] {
  if (nodes.length === 0) return [];

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const inEdges = new Map<string, InputEdge[]>();
  const outEdges = new Map<string, InputEdge[]>();
  for (const n of nodes) {
    inEdges.set(n.id, []);
    outEdges.set(n.id, []);
  }
  for (const e of edges) {
    inEdges.get(e.to)?.push(e);
    outEdges.get(e.from)?.push(e);
  }

  // ── Step 1: Topological sort (Kahn's) ─────────────────────────────────────
  const inDeg = new Map<string, number>();
  for (const n of nodes) inDeg.set(n.id, 0);
  for (const e of edges) inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);

  const queue: string[] = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) queue.push(id);
  }

  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    for (const e of outEdges.get(id) ?? []) {
      const d = inDeg.get(e.to)! - 1;
      inDeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }

  // If topo sort didn't visit all nodes (cycle), append remaining in input order
  if (topoOrder.length < nodes.length) {
    for (const n of nodes) {
      if (!topoOrder.includes(n.id)) topoOrder.push(n.id);
    }
  }

  // ── Step 2: Layer assignment (longest-path from sources) ──────────────────
  const layer = new Map<string, number>();
  for (const id of topoOrder) {
    const predecessors = (inEdges.get(id) ?? []).map(e => e.from);
    if (predecessors.length === 0) {
      layer.set(id, 0);
    } else {
      const maxPredLayer = Math.max(...predecessors.map(p => layer.get(p) ?? 0));
      layer.set(id, maxPredLayer + 1);
    }
  }

  // ── Step 3: Group nodes by layer ──────────────────────────────────────────
  const maxLayer = Math.max(...layer.values(), 0);
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const id of topoOrder) {
    layers[layer.get(id)!].push(id);
  }

  // ── Step 4: Crossing minimization (barycenter heuristic) ──────────────────
  // Forward pass
  for (let l = 1; l <= maxLayer; l++) {
    const barycenters = new Map<string, number>();
    for (const id of layers[l]) {
      const preds = (inEdges.get(id) ?? []).map(e => e.from);
      if (preds.length === 0) {
        barycenters.set(id, 0);
        continue;
      }
      const avgIdx = preds.reduce((sum, p) => {
        const predLayer = layer.get(p)!;
        const idx = layers[predLayer].indexOf(p);
        return sum + idx;
      }, 0) / preds.length;
      barycenters.set(id, avgIdx);
    }
    layers[l].sort((a, b) => (barycenters.get(a) ?? 0) - (barycenters.get(b) ?? 0));
  }

  // Backward pass
  for (let l = maxLayer - 1; l >= 0; l--) {
    const barycenters = new Map<string, number>();
    for (const id of layers[l]) {
      const succs = (outEdges.get(id) ?? []).map(e => e.to);
      if (succs.length === 0) {
        barycenters.set(id, 0);
        continue;
      }
      const avgIdx = succs.reduce((sum, s) => {
        const succLayer = layer.get(s)!;
        const idx = layers[succLayer].indexOf(s);
        return sum + idx;
      }, 0) / succs.length;
      barycenters.set(id, avgIdx);
    }
    layers[l].sort((a, b) => (barycenters.get(a) ?? 0) - (barycenters.get(b) ?? 0));
  }

  // ── Step 5: Position assignment ───────────────────────────────────────────
  const positions = new Map<string, { X: number; Y: number }>();

  for (let l = 0; l <= maxLayer; l++) {
    const nodesInLayer = layers[l];
    const x = LAYOUT.ORIGIN_X + l * LAYOUT.H_SPACING;

    for (let i = 0; i < nodesInLayer.length; i++) {
      const id = nodesInLayer[i];
      const node = nodeMap.get(id)!;
      const phase = getPhase(node, nodeRef);

      // Base Y: center the layer around ORIGIN_Y
      const layerHeight = (nodesInLayer.length - 1) * LAYOUT.V_SPACING;
      let y = LAYOUT.ORIGIN_Y - layerHeight / 2 + i * LAYOUT.V_SPACING;

      // Lookdev offset: shift down
      if (phase === 'lookdev') {
        y += LAYOUT.BRANCH_OFFSET;
      }

      positions.set(id, { X: x, Y: y });
    }
  }

  // ── Step 6: Merge node Y adjustment ───────────────────────────────────────
  for (const id of topoOrder) {
    const node = nodeMap.get(id)!;
    if (MERGE_TYPES.has(node.type)) {
      const preds = (inEdges.get(id) ?? []).map(e => e.from);
      if (preds.length >= 2) {
        const predYs = preds.map(p => positions.get(p)?.Y ?? LAYOUT.ORIGIN_Y).sort((a, b) => a - b);
        const medianY = predYs.length % 2 === 0
          ? (predYs[predYs.length / 2 - 1] + predYs[predYs.length / 2]) / 2
          : predYs[Math.floor(predYs.length / 2)];
        positions.set(id, { X: positions.get(id)!.X, Y: medianY });
      }
    }
  }

  // ── Build output ──────────────────────────────────────────────────────────
  return topoOrder.map(id => ({
    id,
    type: nodeMap.get(id)!.type,
    params: nodeMap.get(id)!.params,
    position: positions.get(id)!,
  }));
}
