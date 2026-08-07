import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'cleaning up the redirector stubs left behind by renames and moves',
  not_when: 'you have not renamed or moved anything — there will be nothing to fix',
};

export const schema = z.object({
  path: z
    .string()
    .optional()
    .describe('Folder to scan, e.g. "/Game/UI". Omit to scan the whole project.'),
});

export const assetFixRedirectorsHandler: ToolHandler = ueTool('asset_fix_redirectors', schema);
