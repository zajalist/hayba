import { z } from 'zod';
import { ensureConnected } from '../tcp-client.js';
import type { PCGEdge } from '../types.js';
import { DEBUG_SUBGRAPHS } from './inject-debug-nodes.js';

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph to instrument'),
  debugSubgraph: z.enum(DEBUG_SUBGRAPHS).optional().describe(
    'PCGEx debug subgraph to inject on each edge (default: DebugEdges). ' +
    'Options: DebugEdges, DebugPaths, DebugBounds, DebugFilters, DebugHeuristics, DebugSphere.'
  ),
  edgeFilter: z.object({
    fromClass: z.string().optional().describe('Only inject on edges from nodes of this class'),
    toClass: z.string().optional().describe('Only inject on edges to nodes of this class'),
    pinName: z.string().optional().describe('Only inject on edges using this pin name (matches from OR to pin)'),
  }).optional().describe('Optional filter — if omitted, debug nodes are injected on ALL edges.'),
  dryRun: z.boolean().optional().describe(
    'If true, return the list of edges that WOULD be instrumented without modifying the asset.'
  ),
});

export type AutoWireDebugOverlayParams = z.infer<typeof schema>;

export async function autoWireDebugOverlay(params: AutoWireDebugOverlayParams) {
  const { assetPath, debugSubgraph = 'DebugEdges', edgeFilter, dryRun = false } = schema.parse(params);

  const client = await ensureConnected();

  const exportResp = await client.send('export_graph', { assetPath });
  if (!exportResp.ok) throw new Error(exportResp.error || 'Failed to export graph');

  const graph = (exportResp.data as any)?.graph ?? exportResp.data;
  if (!graph?.nodes || !graph?.edges) throw new Error('Exported graph is missing nodes/edges');

  const targetEdges: PCGEdge[] = [];

  if (edgeFilter) {
    const nodeById = new Map<string, { id: string; class: string; label: string }>();
    for (const n of graph.nodes as Array<{ id: string; class: string; label: string }>) {
      nodeById.set(n.id, n);
    }
    for (const e of graph.edges as PCGEdge[]) {
      const fromNode = nodeById.get(e.fromNode);
      const toNode = nodeById.get(e.toNode);
      if (edgeFilter.fromClass && fromNode?.class !== edgeFilter.fromClass) continue;
      if (edgeFilter.toClass && toNode?.class !== edgeFilter.toClass) continue;
      if (edgeFilter.pinName && e.fromPin !== edgeFilter.pinName && e.toPin !== edgeFilter.pinName) continue;
      targetEdges.push(e);
    }
  } else {
    targetEdges.push(...(graph.edges as PCGEdge[]));
  }

  if (dryRun) {
    return {
      dryRun: true,
      assetPath,
      debugSubgraph,
      edgesFound: graph.edges.length,
      edgesToInstrument: targetEdges.length,
      edges: targetEdges,
    };
  }

  if (targetEdges.length === 0) {
    return {
      assetPath,
      injected: 0,
      message: 'No edges matched the filter — graph unchanged.',
    };
  }

  const injectResp = await client.send('inject_debug_nodes', {
    assetPath,
    edges: targetEdges,
    label: 'DBG',
    debugSubgraph,
  });

  if (!injectResp.ok) throw new Error(injectResp.error || 'inject_debug_nodes failed');

  return {
    assetPath,
    debugSubgraph,
    edgesFound: graph.edges.length,
    edgesInstrumented: targetEdges.length,
    ...(injectResp.data as object),
  };
}
