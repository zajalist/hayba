import { z } from 'zod';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'enumerating the user\'s Fab library to find assets to import',
  not_when: 'doing a broad marketplace search — use fab_marketplace_search',
};

export const schema = z.object({
  count: z.number().int().min(1).max(100).default(20),
  page: z.string().optional().describe('Pagination cursor from previous call'),
});
export type FabLibraryListParams = z.infer<typeof schema>;

export async function handleFabLibraryList(params: FabLibraryListParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const data = await executeCommand('fab_library_list', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
