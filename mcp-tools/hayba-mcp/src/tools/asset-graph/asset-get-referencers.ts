import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'finding out what would break if you deleted, renamed or moved an asset',
  not_when: 'you want what the asset itself needs (use asset_get_dependencies)',
};

export const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Asset path to look up, e.g. "/Game/UI/T_Panel" or "/Game/UI/T_Panel.T_Panel"'),
});

export const assetGetReferencersHandler: ToolHandler = ueTool('asset_get_referencers', schema);
