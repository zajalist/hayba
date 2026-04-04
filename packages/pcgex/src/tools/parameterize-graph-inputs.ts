import { z } from 'zod';
import type { PCGGraphJSON, PCGNode, PCGEdge } from '../types.js';

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

  const nodeById = new Map(graph.nodes.map(n => [n.id, { ...n, properties: { ...n.properties } }]));
  const newEdges: PCGEdge[] = [];
  const newNodes: PCGNode[] = [];
  const promotedParameters: Array<{ parameterName: string; nodeId: string; property: string; originalValue: unknown }> = [];

  let paramNodeCounter = 1;

  for (const target of targets) {
    const node = nodeById.get(target.nodeId);
    if (!node) {
      continue; // skip missing nodes
    }

    const paramName = target.parameterName || target.property;
    const originalValue = node.properties[target.property];

    // Remove the hardcoded property
    delete node.properties[target.property];

    // Find the node's position to place the GetParameter node upstream
    const paramNodeId = `get_param_${paramName}_${paramNodeCounter++}`;
    const paramNode: PCGNode = {
      id: paramNodeId,
      class: 'PCGGetGraphParameterSettings',
      label: paramName,
      position: {
        x: (node.position?.x ?? 0) - 350,
        y: (node.position?.y ?? 0),
      },
      properties: {
        ParameterName: paramName,
      },
      customData: {},
    };

    // Wire GetParameter output -> node property pin
    // PCGGetGraphParameterSettings outputs on "Output" pin by convention
    const edge: PCGEdge = {
      fromNode: paramNodeId,
      fromPin: 'Output',
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
  };
}
