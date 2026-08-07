import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'renaming an asset in place, with references fixed up rather than broken',
  not_when: 'moving it to a different folder (use asset_move)',
};

export const schema = z.object({
  path: z.string().min(1).describe('Current asset path'),
  new_name: z
    .string()
    .min(1)
    .describe('New asset name only — not a path. The asset stays in its current folder.'),
});

export const assetRenameHandler: ToolHandler = ueTool('asset_rename', schema);
