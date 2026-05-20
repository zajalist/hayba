import { z } from 'zod';
import { executeCommand } from './tool-executor.js';

const schema = z.object({
  assetPath: z.string().min(1).describe('Full UE asset path to the PCGGraph')
});

export type ExportPcgGraphParams = z.infer<typeof schema>;

export async function exportPcgGraph(params: ExportPcgGraphParams) {
  const { assetPath } = schema.parse(params);
  return executeCommand('export_graph', { assetPath });
}
