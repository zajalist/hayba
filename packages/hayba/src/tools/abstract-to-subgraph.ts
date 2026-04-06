import { z } from 'zod';
import type { PCGGraphJSON, PCGNode, PCGEdge } from '../types.js';

const schema = z.object({
  graph: z.string().min(1).describe('JSON string of the full PCGEx graph'),
  nodeIds: z.array(z.string()).min(1).describe('Array of node IDs to extract into a subgraph'),
  subgraphName: z.string().optional().default('SubGraph').describe('Name for the extracted subgraph'),
});

export type AbstractToSubgraphParams = z.infer<typeof schema>;

export async function abstractToSubgraph(params: AbstractToSubgraphParams) {
  const { graph: graphStr, nodeIds, subgraphName } = schema.parse(params);

  let graph: PCGGraphJSON;
  try {
    graph = JSON.parse(graphStr);
  } catch {
    throw new Error('Invalid JSON graph payload');
  }

  const selectedSet = new Set(nodeIds);
  const selectedNodes = graph.nodes.filter(n => selectedSet.has(n.id));
  const remainingNodes = graph.nodes.filter(n => !selectedSet.has(n.id));

  if (selectedNodes.length === 0) throw new Error('No nodes found matching provided nodeIds');

  // BUG-A7: collect warnings for nodeIds not found in graph
  const existingIds = new Set(graph.nodes.map(n => n.id));
  const warnings: string[] = nodeIds
    .filter(id => !existingIds.has(id))
    .map(id => `nodeId "${id}" not found in graph`);

  // Classify edges
  const internalEdges: PCGEdge[] = [];
  const boundaryIncoming: PCGEdge[] = []; // from outside -> inside selection
  const boundaryOutgoing: PCGEdge[] = []; // from inside -> outside selection
  const externalEdges: PCGEdge[] = [];

  for (const edge of graph.edges) {
    const fromIn = selectedSet.has(edge.fromNode);
    const toIn = selectedSet.has(edge.toNode);
    if (fromIn && toIn) internalEdges.push(edge);
    else if (!fromIn && toIn) boundaryIncoming.push(edge);
    else if (fromIn && !toIn) boundaryOutgoing.push(edge);
    else externalEdges.push(edge);
  }

  // Build boundary pin lists
  // BUG-A3+A4: use fromNode in pin name to prevent collisions
  const boundaryInputPins = boundaryIncoming.map(e => ({
    externalFromNode: e.fromNode,
    externalFromPin: e.fromPin,
    internalToNode: e.toNode,
    internalToPin: e.toPin,
    paramName: `Input_${e.fromNode}_${e.fromPin}`,
  }));

  const boundaryOutputPins = boundaryOutgoing.map(e => ({
    internalFromNode: e.fromNode,
    internalFromPin: e.fromPin,
    externalToNode: e.toNode,
    externalToPin: e.toPin,
    paramName: `Output_${e.fromNode}_${e.fromPin}`,
  }));

  // Build subgraph JSON
  // BUG-A1: only add boundary nodes when there are boundary edges
  const inputBoundaryNode: PCGNode | null = boundaryIncoming.length > 0 ? {
    id: 'boundary_input',
    class: 'PCGGraphInputOutputSettings',
    label: 'Inputs',
    position: { x: -400, y: 0 },
    properties: { bIsInput: true },
    customData: {},
  } : null;

  const outputBoundaryNode: PCGNode | null = boundaryOutgoing.length > 0 ? {
    id: 'boundary_output',
    class: 'PCGGraphInputOutputSettings',
    label: 'Outputs',
    position: { x: 600, y: 0 },
    properties: { bIsInput: false },
    customData: {},
  } : null;

  const subgraphInputEdges: PCGEdge[] = boundaryInputPins.map(bp => ({
    fromNode: 'boundary_input',
    fromPin: bp.paramName,
    toNode: bp.internalToNode,
    toPin: bp.internalToPin,
  }));

  const subgraphOutputEdges: PCGEdge[] = boundaryOutputPins.map(bp => ({
    fromNode: bp.internalFromNode,
    fromPin: bp.internalFromPin,
    toNode: 'boundary_output',
    toPin: bp.paramName,
  }));

  // BUG-A5: reset metadata on subgraph so it doesn't inherit parent metadata
  const subgraphJSON: PCGGraphJSON = {
    ...graph,
    meta: {
      ...graph.meta,
      sourceGraph: subgraphName,
      exportedAt: new Date().toISOString(),
    },
    metadata: { graphSettings: {}, inputSettings: {}, outputSettings: {} },
    nodes: [
      ...(inputBoundaryNode ? [inputBoundaryNode] : []),
      ...selectedNodes,
      ...(outputBoundaryNode ? [outputBoundaryNode] : []),
    ],
    edges: [...subgraphInputEdges, ...internalEdges, ...subgraphOutputEdges],
  };

  // Build subgraph call node for parent graph
  const subgraphCallNodeId = `subgraph_call_${subgraphName}`;
  const subgraphCallNode: PCGNode = {
    id: subgraphCallNodeId,
    class: 'PCGExecuteSubgraphSettings',
    label: subgraphName,
    position: { x: 0, y: 0 }, // caller should run format_graph_topology after
    // BUG-A6: SubgraphAsset comment to guide user
    properties: { SubgraphAsset: `// TODO: set to UE asset path for ${subgraphName}` },
    customData: {},
  };

  // Rewire boundary edges in parent (use same unique pin naming as subgraph boundary)
  const rewiredIncoming: PCGEdge[] = boundaryIncoming.map(e => ({
    fromNode: e.fromNode,
    fromPin: e.fromPin,
    toNode: subgraphCallNodeId,
    toPin: `Input_${e.fromNode}_${e.fromPin}`,
  }));

  const rewiredOutgoing: PCGEdge[] = boundaryOutgoing.map(e => ({
    fromNode: subgraphCallNodeId,
    fromPin: `Output_${e.fromNode}_${e.fromPin}`,
    toNode: e.toNode,
    toPin: e.toPin,
  }));

  const parentGraph: PCGGraphJSON = {
    ...graph,
    nodes: [...remainingNodes, subgraphCallNode],
    edges: [...externalEdges, ...rewiredIncoming, ...rewiredOutgoing],
  };

  return {
    parentGraph: JSON.stringify(parentGraph, null, 2),
    subgraph: JSON.stringify(subgraphJSON, null, 2),
    subgraphName,
    boundaryInputPins,
    boundaryOutputPins,
    warnings,
  };
}
