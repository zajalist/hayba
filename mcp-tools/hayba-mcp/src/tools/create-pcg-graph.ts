import { z } from 'zod';
import { executeCommand } from './tool-executor.js';
import { getGraphPatterns } from '../graph-patterns.js';
import type { PCGGraphJSON } from '../types.js';

export const PCG_GRAPH_PATH_DESCRIPTION =
  'Content folder for the graph asset, e.g. "/Game/Environment/PCG" (default /Game/Hayba/Generated). ' +
  'A PCG graph that already exists there under this name is rebuilt in place, so references to it stay valid.';

const schema = z.object({
  graph: z.string().min(1).describe(
    'JSON string of the PCGEx graph topology. ' +
    'IMPORTANT rules before building:\n' + getGraphPatterns()
  ),
  name: z.string().min(1).describe('Name for the new PCGGraph asset'),
  path: z.string().min(1).optional().describe(PCG_GRAPH_PATH_DESCRIPTION),
});

export type CreatePcgGraphParams = z.infer<typeof schema>;

export async function createPcgGraph(params: CreatePcgGraphParams) {
  const { graph: graphStr, name, path } = schema.parse(params);

  let graph: PCGGraphJSON;
  try {
    graph = JSON.parse(graphStr);
  } catch {
    throw new Error('Invalid JSON graph payload');
  }

  return executeCommand('create_graph', path ? { graph, name, path } : { graph, name });
}
