import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'finding out what an asset pulls in — what must exist for it to load',
  not_when: 'you want what depends ON it (use asset_get_referencers)',
};

export const schema = z.object({
  path: z.string().min(1).describe('Asset path whose dependencies to list'),
});

export const assetGetDependenciesHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('asset_get_dependencies', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
