import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['renames_asset', 'modifies_project'],
  when: 'renaming a content asset in place (same folder, new name)',
  not_when: 'moving to another folder (asset_move) or deleting (asset_delete) an asset',
};

export const schema = z.object({
  path: z.string().min(1).describe('Object path of the asset to rename, e.g. /Game/Foo/MF_X.MF_X'),
  new_name: z.string().min(1).describe('New asset name only (not a path), e.g. MF_Y'),
});

export const assetRenameHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('asset_rename', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
