import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
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

export const assetFixRedirectorsHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('asset_fix_redirectors', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
