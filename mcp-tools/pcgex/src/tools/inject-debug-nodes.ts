import { z } from 'zod';
import { ensureConnected } from '../tcp-client.js';

export const DEBUG_SUBGRAPHS = ['DebugEdges', 'DebugPaths', 'DebugBounds', 'DebugFilters', 'DebugHeuristics', 'DebugSphere'] as const;

const edgeSpec = z.object({
  fromNode: z.string().describe('Source node ID (e.g. node_002)'),
  fromPin: z.string().describe('Source output pin name'),
  toNode: z.string().describe('Target node ID'),
  toPin: z.string().describe('Target input pin name'),
});

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph to modify'),
  edges: z.array(edgeSpec).min(1).describe(
    'Edges on which to inject debug subgraph nodes. ' +
    'Call export_pcg_graph first to get current node IDs — they are positional and change when the graph is modified.'
  ),
  label: z.string().optional().describe('Label prefix for injected node IDs in the response (default: DBG)'),
  debugSubgraph: z.enum(DEBUG_SUBGRAPHS).optional().describe(
    'PCGEx debug subgraph to inject (default: DebugEdges). ' +
    'Options: DebugEdges, DebugPaths, DebugBounds, DebugFilters, DebugHeuristics, DebugSphere. ' +
    'These are subgraph assets from /PCGExtendedToolkit/Subgraphs/.'
  ),
});

export type InjectDebugNodesParams = z.infer<typeof schema>;

export async function injectDebugNodes(params: InjectDebugNodesParams) {
  const { assetPath, edges, label = 'DBG', debugSubgraph = 'DebugEdges' } = schema.parse(params);

  const client = await ensureConnected();
  const response = await client.send('inject_debug_nodes', {
    assetPath,
    edges,
    label,
    debugSubgraph,
  });

  if (!response.ok) {
    throw new Error(response.error || 'inject_debug_nodes failed');
  }

  return response.data;
}
