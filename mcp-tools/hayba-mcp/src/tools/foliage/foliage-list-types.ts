import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'finding out which FoliageType assets the current level actually uses',
  not_when: 'you want instance counts or placement — this lists the types',
};

export const schema = z.object({
  // No parameters: the command reports the foliage types present in the level.
});

export const foliageListTypesHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('foliage_list_types', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
