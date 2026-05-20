import { z } from 'zod';
import { executeCommand } from './tool-executor.js';

const schema = z.object({
  path: z.string().optional().describe('Content path filter (default: /Game/)')
});

export type ListPcgAssetsParams = z.infer<typeof schema>;

export async function listPcgAssets(params: ListPcgAssetsParams) {
  const { path } = schema.parse(params);
  return executeCommand('list_pcg_assets', { path: path || '/Game/' });
}
