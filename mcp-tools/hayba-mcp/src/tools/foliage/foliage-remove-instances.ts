import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_level'],
  when: 'clearing foliage instances inside a bounding box',
  not_when: 'removing the FoliageType asset itself — this removes placed instances',
};

export const schema = z.object({
  foliage_type_path: z
    .string()
    .min(1)
    .describe('FoliageType whose instances to remove'),
  bounds: z
    .object({
      min: z.object({ x: z.number(), y: z.number(), z: z.number() }).describe('Minimum corner of the world-space box'),
      max: z.object({ x: z.number(), y: z.number(), z: z.number() }).describe('Maximum corner of the world-space box'),
    })
    .describe('World-space box; instances inside it are removed.'),
});

export const foliageRemoveInstancesHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('foliage_remove_instances', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
