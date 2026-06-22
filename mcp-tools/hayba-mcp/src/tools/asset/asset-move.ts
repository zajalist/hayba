import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['moves_asset', 'modifies_project'],
  when: 'relocating a content asset to a different folder, keeping its name (references/redirectors handled)',
  not_when: 'renaming in place (asset_rename) or deleting (asset_delete) an asset',
};

export const schema = z.object({
  path: z.string().min(1).describe('Object path of the asset to move, e.g. /Game/Foo/MF_X.MF_X'),
  target_dir: z.string().min(1).describe('Destination folder path (no asset name), e.g. /Game/MaterialLibrary/functions/primitives'),
});

export const assetMoveHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('asset_move', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
