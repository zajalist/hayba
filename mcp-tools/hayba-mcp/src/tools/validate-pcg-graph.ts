import { z } from 'zod';
import { executeCommand } from './tool-executor.js';
import type { PCGGraphJSON } from '../types.js';

const schema = z.object({
  graph: z.string().min(1).describe('JSON string of the PCGEx graph to validate')
});

export type ValidatePcgGraphParams = z.infer<typeof schema>;

export async function validatePcgGraph(params: ValidatePcgGraphParams) {
  const { graph: graphStr } = schema.parse(params);

  let graph: PCGGraphJSON;
  try {
    graph = JSON.parse(graphStr);
  } catch {
    return { valid: false, errors: [{ type: 'schema', detail: 'Invalid JSON' }] };
  }

  if (!graph.nodes || !graph.edges) {
    return { valid: false, errors: [{ type: 'schema', detail: 'Missing required fields: nodes, edges' }] };
  }

  try {
    return await executeCommand('validate_graph', { graph });
  } catch (err) {
    return { valid: false, errors: [{ type: 'connection', detail: `Cannot reach UE for validation: ${err instanceof Error ? err.message : 'unknown'}` }] };
  }
}
