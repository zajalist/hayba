import { z } from 'zod';
import { executeCommand } from './tool-executor.js';
import { getGraphPatterns } from '../graph-patterns.js';
import type { PCGGraphJSON } from '../types.js';

const schema = z.object({
  graph: z.string().min(1).describe(
    'JSON string of the PCGEx graph topology. ' +
    'IMPORTANT rules before building:\n' + getGraphPatterns()
  ),
  name: z.string().min(1).describe('Name for the new PCGGraph asset')
});

export type CreatePcgGraphParams = z.infer<typeof schema>;

export async function createPcgGraph(params: CreatePcgGraphParams) {
  const { graph: graphStr, name } = schema.parse(params);

  let graph: PCGGraphJSON;
  try {
    graph = JSON.parse(graphStr);
  } catch {
    throw new Error('Invalid JSON graph payload');
  }

  return executeCommand('create_graph', { graph, name });
}
