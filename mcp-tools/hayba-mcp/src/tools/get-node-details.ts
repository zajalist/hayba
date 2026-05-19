import { z } from 'zod';
import { getNodeByClass } from '../catalog.js';
import { executeCommand } from './tool-executor.js';

const schema = z.object({
  class: z.string().min(1).describe('PCGEx node class name (e.g., PCGExBuildDelaunayGraph2D)')
});

export type GetNodeDetailsParams = z.infer<typeof schema>;

export async function getNodeDetails(params: GetNodeDetailsParams) {
  const { class: className } = schema.parse(params);

  const catalogEntry = getNodeByClass(className);
  if (catalogEntry) {
    return { source: 'catalog', ...catalogEntry };
  }

  try {
    const data = await executeCommand<Record<string, unknown>>('get_node_details', { class: className });
    return { source: 'ue_runtime', ...data };
  } catch (err) {
    throw new Error(`Node class '${className}' not found in catalog or UE. ${err instanceof Error ? err.message : ''}`);
  }
}
