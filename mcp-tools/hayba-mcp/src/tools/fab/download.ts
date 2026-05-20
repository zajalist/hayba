import { z } from 'zod';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['filesystem_write', 'asset_create'],
  when: 'downloading a Fab asset (from library_list or marketplace_search results) into the active project',
  not_when: 'you only need metadata — use library_list / marketplace_search',
};

export const schema = z.object({
  asset_id: z.string().min(1),
  download_url: z.string().url().describe('Signed download URL from library_list / search result item'),
  target_dir: z.string().optional().describe('Project content path, e.g. /Game/Fab/MyAsset. Defaults to /Game/Fab/<asset_id>.'),
  wait: z.boolean().default(true).describe('If true, blocks until download completes (up to 10min cap on the C++ side).'),
});
export type FabDownloadParams = z.infer<typeof schema>;

export async function handleFabDownload(params: FabDownloadParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const data = await executeCommand('fab_download', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
