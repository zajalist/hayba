import { z } from 'zod';
import { executeCommand } from './tool-executor.js';

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph to execute')
});

export type ExecutePcgGraphParams = z.infer<typeof schema>;

export async function executePcgGraph(params: ExecutePcgGraphParams) {
  const { assetPath } = schema.parse(params);
  return executeCommand('execute_graph', { assetPath });
}
