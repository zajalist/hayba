import { z } from 'zod';
import { ensureConnected } from '../tcp-client.js';

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph to execute')
});

export type ExecutePcgGraphParams = z.infer<typeof schema>;

export async function executePcgGraph(params: ExecutePcgGraphParams) {
  const { assetPath } = schema.parse(params);
  const client = await ensureConnected();
  const response = await client.send('execute_graph', { assetPath });
  if (!response.ok) throw new Error(response.error || 'Failed to execute graph');
  return response.data;
}
