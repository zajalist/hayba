import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { TOOL_ALIASES } from '../tool-aliases.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['deletes_asset', 'modifies_project'],
  when: 'permanently deleting a content asset by object path',
  not_when: 'moving (asset_move) or renaming (asset_rename) an asset',
};

export const schema = z
  .object({
    path: z.string().optional().describe('Object path of one asset to delete, e.g. /Game/Foo/MF_X.MF_X'),
    paths: z
      .array(z.string().min(1))
      .optional()
      .describe('Several assets in one call. Prefer this over looping — one call reports which ones actually went.'),
  })
  .refine((v) => (v.path && v.path.length > 0) || (v.paths && v.paths.length > 0), {
    message: 'give `path` (string) or `paths` (array of strings)',
  });

export const assetDeleteHandler: ToolHandler = ueTool('asset_delete', schema, TOOL_ALIASES.asset_delete);
