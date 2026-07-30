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

export const assetDeleteHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('asset_delete', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
