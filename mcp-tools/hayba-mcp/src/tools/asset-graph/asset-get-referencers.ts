import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
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

export const assetGetReferencersHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('asset_get_referencers', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
