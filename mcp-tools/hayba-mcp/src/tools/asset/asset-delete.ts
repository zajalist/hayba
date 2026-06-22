import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['deletes_asset', 'modifies_project'],
  when: 'permanently deleting a content asset by object path',
  not_when: 'moving (asset_move) or renaming (asset_rename) an asset',
};

export const schema = z.object({
  path: z.string().min(1).describe('Object path of the asset to delete, e.g. /Game/Foo/MF_X.MF_X'),
});

export const assetDeleteHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('asset_delete', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
