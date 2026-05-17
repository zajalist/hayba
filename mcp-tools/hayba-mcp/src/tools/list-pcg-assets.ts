import { z } from 'zod';
import { ensureConnected } from '../tcp-client.js';

const schema = z.object({
  path: z.string().optional().describe('Content path filter (default: /Game/)')
});

export type ListPcgAssetsParams = z.infer<typeof schema>;

export async function listPcgAssets(params: ListPcgAssetsParams) {
  const { path } = schema.parse(params);
  const client = await ensureConnected();
  const response = await client.send('list_pcg_assets', { path: path || '/Game/' });
  if (!response.ok) throw new Error(response.error || 'Failed to list assets');
  return response.data;
}
