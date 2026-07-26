import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'moving an asset to another folder while keeping references working',
  not_when: 'only changing the name (use asset_rename)',
};

export const schema = z.object({
  path: z.string().min(1).describe('Current asset path'),
  target_dir: z
    .string()
    .min(1)
    .describe('Destination folder, e.g. "/Game/UI/Icons". The asset keeps its name.'),
});

export const assetMoveHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('asset_move', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
