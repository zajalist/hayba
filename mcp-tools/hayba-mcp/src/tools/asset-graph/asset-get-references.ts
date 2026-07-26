import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'you want both directions of an asset reference graph in one call',
  not_when: 'you only need one direction — the single-direction tools return an exact count rather than a capped list',
};

export const schema = z.object({
  path: z.string().min(1).describe('Asset path to inspect'),
});

export const assetGetReferencesHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('asset_get_references', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
