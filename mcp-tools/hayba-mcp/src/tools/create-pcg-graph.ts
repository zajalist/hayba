import { z } from 'zod';
import { ensureConnected } from '../tcp-client.js';
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

  const client = await ensureConnected();
  const response = await client.send('create_graph', { graph, name });

  if (!response.ok) {
    throw new Error(response.error || 'Failed to create graph in UE');
  }

  return response.data;
}
