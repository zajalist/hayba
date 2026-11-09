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
  unreferenced: z
    .enum(['delete', 'keep'])
    .optional()
    .describe(
      'What to do with redirectors nothing references once their referencers are re-pointed and saved: "delete" (default) or "keep". Never opens a dialog either way.',
    ),
});

export const assetFixRedirectorsHandler: ToolHandler = ueTool('asset_fix_redirectors', schema);
