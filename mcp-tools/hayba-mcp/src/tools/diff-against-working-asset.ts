import { z } from 'zod';
import { ensureConnected } from '../tcp-client.js';
import type { PCGGraphJSON, PCGNode, PCGEdge } from '../types.js';

const schema = z.object({
  wipGraph: z.string().min(1).describe('JSON string of the work-in-progress graph'),
  referenceAssetPath: z.string().min(1).describe('Full UE asset path to the reference PCGGraph'),
  diffMode: z.enum(['structural', 'properties', 'full']).default('full').describe('What to diff'),
});

export type DiffAgainstWorkingAssetParams = z.infer<typeof schema>;

function nodeKey(node: PCGNode): string {
  return `${node.class}::${node.label || node.id}`;
}

function edgeKey(edge: PCGEdge): string {
  return `${edge.fromNode}:${edge.fromPin}->${edge.toNode}:${edge.toPin}`;
}

function buildNodeKeyMap(nodes: PCGNode[]): Map<string, PCGNode> {
  // BUG-D1: handle duplicate class::label keys by appending ::0, ::1 suffixes
  const map = new Map<string, PCGNode>();
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const base = nodeKey(node);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    map.set(count === 0 ? base : `${base}::${count}`, node);
  }
  return map;
}

function buildEdgeKeySet(edges: PCGEdge[], nodeById: Map<string, PCGNode>): Map<string, PCGEdge> {
  const map = new Map<string, PCGEdge>();
  for (const e of edges) {
    // Resolve edge keys using class::label for stability
    const fromNode = nodeById.get(e.fromNode);
    const toNode = nodeById.get(e.toNode);
    const fromKey = fromNode ? nodeKey(fromNode) : e.fromNode;
    const toKey = toNode ? nodeKey(toNode) : e.toNode;
    const key = `${fromKey}:${e.fromPin}->${toKey}:${e.toPin}`;
    map.set(key, e);
  }
  return map;
}

export async function diffAgainstWorkingAsset(params: DiffAgainstWorkingAssetParams) {
  const { wipGraph: wipStr, referenceAssetPath, diffMode } = schema.parse(params);

  let wipGraph: PCGGraphJSON;
  try {
    wipGraph = JSON.parse(wipStr);
  } catch {
    throw new Error('Invalid JSON for wipGraph');
  }

  const client = await ensureConnected();
  const response = await client.send('export_graph', { assetPath: referenceAssetPath });
  if (!response.ok) throw new Error(response.error || 'Failed to export reference graph');

  // BUG-D7: response.data is Record<string, unknown>; UE export_graph wraps graph in { graph: ... }
  const refGraph: PCGGraphJSON = (response.data as any)?.graph ?? (response.data as unknown as PCGGraphJSON);

  const wipNodeMap = buildNodeKeyMap(wipGraph.nodes);
  const refNodeMap = buildNodeKeyMap(refGraph.nodes);

  const addedNodes: string[] = [];
  const removedNodes: string[] = [];

  for (const key of wipNodeMap.keys()) {
    if (!refNodeMap.has(key)) addedNodes.push(key);
  }
  for (const key of refNodeMap.keys()) {
    if (!wipNodeMap.has(key)) removedNodes.push(key);
  }

  // Edge diff using stable keys
  const wipNodeById = new Map(wipGraph.nodes.map(n => [n.id, n]));
  const refNodeById = new Map(refGraph.nodes.map(n => [n.id, n]));
  const wipEdgeMap = buildEdgeKeySet(wipGraph.edges, wipNodeById);
  const refEdgeMap = buildEdgeKeySet(refGraph.edges, refNodeById);

  const addedEdges: string[] = [];
  const removedEdges: string[] = [];

  for (const key of wipEdgeMap.keys()) {
    if (!refEdgeMap.has(key)) addedEdges.push(key);
  }
  for (const key of refEdgeMap.keys()) {
    if (!wipEdgeMap.has(key)) removedEdges.push(key);
  }

  // Property changes
  const propertyChanges: Array<{ nodeKey: string; property: string; wipValue: unknown; refValue: unknown }> = [];
  const positionChanges: Array<{ nodeKey: string; wipPos: { x: number; y: number }; refPos: { x: number; y: number } }> = [];

  if (diffMode === 'properties' || diffMode === 'full') {
    for (const [key, wipNode] of wipNodeMap) {
      const refNode = refNodeMap.get(key);
      if (!refNode) continue;

      // Property diff
      const allProps = new Set([...Object.keys(wipNode.properties), ...Object.keys(refNode.properties)]);
      for (const prop of allProps) {
        const wipVal = wipNode.properties[prop];
        const refVal = refNode.properties[prop];
        if (JSON.stringify(wipVal) !== JSON.stringify(refVal)) {
          propertyChanges.push({ nodeKey: key, property: prop, wipValue: wipVal, refValue: refVal });
        }
      }

      // Position diff
      if (wipNode.position && refNode.position) {
        if (wipNode.position.x !== refNode.position.x || wipNode.position.y !== refNode.position.y) {
          positionChanges.push({ nodeKey: key, wipPos: wipNode.position, refPos: refNode.position });
        }
      }
    }
  }

  const identical =
    addedNodes.length === 0 &&
    removedNodes.length === 0 &&
    addedEdges.length === 0 &&
    removedEdges.length === 0 &&
    propertyChanges.length === 0 &&
    positionChanges.length === 0;

  // BUG-D5: qualify summary based on diffMode
  const identicalLabel = diffMode === 'structural' ? 'Graphs are structurally identical' : 'Graphs are identical';
  const summary = identical
    ? identicalLabel
    : [
        addedNodes.length ? `+${addedNodes.length} nodes` : '',
        removedNodes.length ? `-${removedNodes.length} nodes` : '',
        addedEdges.length ? `+${addedEdges.length} edges` : '',
        removedEdges.length ? `-${removedEdges.length} edges` : '',
        propertyChanges.length ? `${propertyChanges.length} property changes` : '',
        positionChanges.length ? `${positionChanges.length} position changes` : '',
      ].filter(Boolean).join(', ');

  return {
    identical,
    diff: { addedNodes, removedNodes, addedEdges, removedEdges, propertyChanges, positionChanges, summary },
    wipNodeCount: wipGraph.nodes.length,
    refNodeCount: refGraph.nodes.length,
  };
}
