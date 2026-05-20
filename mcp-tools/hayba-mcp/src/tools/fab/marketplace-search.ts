import { z } from 'zod';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'searching the public Fab marketplace for assets matching a query',
  not_when: 'you only want assets the user already owns — use fab_library_list',
};

export const schema = z.object({
  query: z.string().min(1),
  type: z.string().optional().describe('Filter by asset type (e.g. "Material", "StaticMesh")'),
  page: z.string().optional(),
});
export type FabSearchParams = z.infer<typeof schema>;

export async function handleFabMarketplaceSearch(params: FabSearchParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const data = await executeCommand('fab_marketplace_search', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
