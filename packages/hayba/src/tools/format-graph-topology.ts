import { z } from 'zod';
import type { PCGGraphJSON, PCGNode, PCGEdge } from '../types.js';

const schema = z.object({
  graph: z.string().min(1).describe('JSON string of the PCGEx graph to format'),
  algorithm: z.enum(['layered', 'grid']).default('layered').describe('Layout algorithm'),
  nodeWidth: z.number().int().default(200),
  nodeHeight: z.number().int().default(100),
  horizontalSpacing: z.number().int().default(150),
  verticalSpacing: z.number().int().default(80),
  addCommentBlocks: z.boolean().optional().default(false).describe('Wrap category clusters in PCGComment nodes'),
});

export type FormatGraphTopologyParams = z.infer<typeof schema>;

function assignLayersLongestPath(nodes: PCGNode[], edges: PCGEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>(); // fromNode -> toNodes
  const inDegree = new Map<string, number>();

  for (const n of nodes) {
    adj.set(n.id, []);
    inDegree.set(n.id, 0);
  }

  for (const e of edges) {
    adj.get(e.fromNode)?.push(e.toNode);
    inDegree.set(e.toNode, (inDegree.get(e.toNode) ?? 0) + 1);
  }

  // Kahn's topo sort to assign longest path layers
  const layers = new Map<string, number>();
  const queue: string[] = [];

  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      queue.push(id);
      layers.set(id, 0);
    }
  }

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currLayer = layers.get(curr) ?? 0;

    for (const next of (adj.get(curr) ?? [])) {
      const newLayer = currLayer + 1;
      if ((layers.get(next) ?? -1) < newLayer) {
        layers.set(next, newLayer);
      }
      const newDeg = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  // Fallback for any unvisited (cycles)
  for (const n of nodes) {
    if (!layers.has(n.id)) layers.set(n.id, 0);
  }

  return layers;
}

function layeredLayout(
  nodes: PCGNode[],
  edges: PCGEdge[],
  nodeWidth: number,
  nodeHeight: number,
  horizontalSpacing: number,
  verticalSpacing: number
): PCGNode[] {
  const layers = assignLayersLongestPath(nodes, edges);

  // Group nodes by layer
  const byLayer = new Map<number, string[]>();
  for (const [id, layer] of layers) {
    if (!byLayer.has(layer)) byLayer.set(layer, []);
    byLayer.get(layer)!.push(id);
  }

  // BUG-F7: sort nodes within each layer by id for deterministic layout
  for (const ids of byLayer.values()) {
    ids.sort();
  }

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const updated: PCGNode[] = [];

  for (const [layer, ids] of byLayer) {
    const x = layer * (nodeWidth + horizontalSpacing);
    ids.forEach((id, rowIndex) => {
      const node = nodeById.get(id);
      if (node) {
        updated.push({
          ...node,
          position: {
            x: Math.round(x),
            y: Math.round(rowIndex * (nodeHeight + verticalSpacing)),
          },
        });
      }
    });
  }

  return updated;
}

function gridLayout(
  nodes: PCGNode[],
  nodeWidth: number,
  nodeHeight: number,
  horizontalSpacing: number,
  verticalSpacing: number
): PCGNode[] {
  const cols = Math.ceil(Math.sqrt(nodes.length));
  return nodes.map((node, i) => ({
    ...node,
    position: {
      x: Math.round((i % cols) * (nodeWidth + horizontalSpacing)),
      y: Math.round(Math.floor(i / cols) * (nodeHeight + verticalSpacing)),
    },
  }));
}

function buildCommentBlocks(nodes: PCGNode[], nodeWidth: number, nodeHeight: number): PCGNode[] {
  // Group by class prefix to infer category
  const groups = new Map<string, PCGNode[]>();
  for (const node of nodes) {
    // BUG-F5: fix regex to match both UPCG and UPCGEx prefixes
    const match = node.class.match(/^UPCG(?:Ex)?(\w+?)(?:Settings)?$/i);
    const group = match ? match[1].substring(0, 4) : 'Misc';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(node);
  }

  const commentNodes: PCGNode[] = [];
  let commentId = 9000;

  for (const [group, groupNodes] of groups) {
    if (groupNodes.length < 2) continue;
    const xs = groupNodes.map(n => n.position.x);
    const ys = groupNodes.map(n => n.position.y);
    const minX = Math.min(...xs) - 20;
    const minY = Math.min(...ys) - 40;
    // BUG-F4: use nodeWidth/nodeHeight instead of hardcoded 220/120
    const maxX = Math.max(...xs) + nodeWidth + 20;
    const maxY = Math.max(...ys) + nodeHeight + 20;

    commentNodes.push({
      id: `comment_${commentId++}`,
      class: 'PCGCommentSettings',
      label: group,
      position: { x: minX, y: minY },
      properties: { CommentText: group, Width: maxX - minX, Height: maxY - minY },
      customData: {},
    });
  }

  return commentNodes;
}

export async function formatGraphTopology(params: FormatGraphTopologyParams) {
  const { graph: graphStr, algorithm, nodeWidth, nodeHeight, horizontalSpacing, verticalSpacing, addCommentBlocks } = schema.parse(params);

  let graph: PCGGraphJSON;
  try {
    graph = JSON.parse(graphStr);
  } catch {
    throw new Error('Invalid JSON graph payload');
  }

  let updatedNodes: PCGNode[];

  if (algorithm === 'layered') {
    updatedNodes = layeredLayout(graph.nodes, graph.edges, nodeWidth, nodeHeight, horizontalSpacing, verticalSpacing);
  } else {
    updatedNodes = gridLayout(graph.nodes, nodeWidth, nodeHeight, horizontalSpacing, verticalSpacing);
  }

  const extraNodes = addCommentBlocks ? buildCommentBlocks(updatedNodes, nodeWidth, nodeHeight) : [];

  const result: PCGGraphJSON = {
    ...graph,
    nodes: [...updatedNodes, ...extraNodes],
  };

  return JSON.stringify(result, null, 2);
}
