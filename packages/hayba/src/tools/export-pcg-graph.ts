import { z } from 'zod';
import { ensureConnected } from '../tcp-client.js';

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph')
});

export type ExportPcgGraphParams = z.infer<typeof schema>;

export async function exportPcgGraph(params: ExportPcgGraphParams) {
  const { assetPath } = schema.parse(params);
  const client = await ensureConnected();
  const response = await client.send('export_graph', { assetPath });
  if (!response.ok) throw new Error(response.error || 'Failed to export graph');
  return response.data;
}
