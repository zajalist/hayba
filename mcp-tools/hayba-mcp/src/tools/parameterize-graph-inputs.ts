import { z } from 'zod';
import type { PCGGraphJSON, PCGNode, PCGEdge } from '../types.js';
import { normalizeEdges } from '../types.js';

const schema = z.object({
  graph: z.string().min(1).describe('JSON string of the PCGEx graph'),
  targets: z.array(z.object({
    nodeId: z.string().describe('Node ID containing the hardcoded property'),
    property: z.string().describe('Property name to parameterize'),
    parameterName: z.string().optional().describe('Name for the graph parameter (defaults to property name)'),
  })).min(1).describe('List of property targets to parameterize'),
});

export type ParameterizeGraphInputsParams = z.infer<typeof schema>;

export async function parameterizeGraphInputs(params: ParameterizeGraphInputsParams) {
  const { graph: graphStr, targets } = schema.parse(params);

  let graph: PCGGraphJSON;
  try {
    graph = JSON.parse(graphStr);
  } catch {
    throw new Error('Invalid JSON graph payload');
  }
  // Accept either canonical (fromNode/toNode) or legacy (from/to) edge keys.
  graph.edges = normalizeEdges(graph.edges as unknown as any[]);

  const nodeById = new Map(graph.nodes.map(n => [n.id, { ...n, properties: { ...n.properties } }]));
  const newEdges: PCGEdge[] = [];
  const newNodes: PCGNode[] = [];
  const promotedParameters: Array<{ parameterName: string; nodeId: string; property: string; originalValue: unknown }> = [];
  // BUG-3: collect skipped IDs
  const skippedNodeIds: string[] = [];

  let paramNodeCounter = 1;
  // Track how many GetParameter nodes we've stacked next to each target node
  // so multiple parameters on the same node don't overlap.
  const paramsPerNode = new Map<string, number>();
  const PARAM_VERTICAL_GAP = 120;

  for (const target of targets) {
    const node = nodeById.get(target.nodeId);
    if (!node) {
      skippedNodeIds.push(target.nodeId);
      continue; // skip missing nodes
    }

    // BUG-2: default parameterName to `${node.label}_${property}` for clarity
    const paramName = target.parameterName || `${node.label || target.nodeId}_${target.property}`;
    const originalValue = node.properties[target.property];

    // Remove the hardcoded property
    delete node.properties[target.property];

    // Find the node's position to place the GetParameter node upstream.
    // Stack each subsequent param vertically so they don't overlap.
    const stackIdx = paramsPerNode.get(target.nodeId) ?? 0;
    paramsPerNode.set(target.nodeId, stackIdx + 1);
    const paramNodeId = `get_param_${paramName}_${paramNodeCounter++}`;
    const paramNode: PCGNode = {
      id: paramNodeId,
      class: 'PCGGetGraphParameterSettings',
      label: paramName,
      position: {
        x: (node.position?.x ?? 0) - 350,
        y: (node.position?.y ?? 0) + stackIdx * PARAM_VERTICAL_GAP,
      },
      properties: {
        ParameterName: paramName,
      },
      customData: {},
    };

    // Wire GetParameter output -> node property pin
    // BUG-1: PCGGetGraphParameterSettings outputs on "Out" pin
    const edge: PCGEdge = {
      fromNode: paramNodeId,
      fromPin: 'Out',
      toNode: target.nodeId,
      toPin: target.property,
    };

    newNodes.push(paramNode);
    newEdges.push(edge);
    nodeById.set(target.nodeId, node);

    promotedParameters.push({
      parameterName: paramName,
      nodeId: target.nodeId,
      property: target.property,
      originalValue,
    });
  }

  const updatedGraph: PCGGraphJSON = {
    ...graph,
    nodes: [...nodeById.values(), ...newNodes],
    edges: [...graph.edges, ...newEdges],
  };

  return {
    graph: JSON.stringify(updatedGraph, null, 2),
    promotedParameters,
    skippedNodeIds,
  };
}
