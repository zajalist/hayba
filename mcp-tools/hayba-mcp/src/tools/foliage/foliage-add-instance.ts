import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_level'],
  when: 'placing a single foliage instance at an exact transform',
  not_when: 'scattering many over an area (use foliage_paint_at)',
};

export const schema = z.object({
  foliage_type_path: z
    .string()
    .min(1)
    .describe('FoliageType asset path, e.g. "/Game/Foliage/FT_Grass"'),
  transform: z
    .object({
      location: z.object({ x: z.number(), y: z.number(), z: z.number() }).describe('World location. Required.'),
      rotation: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional().describe('Pitch/Yaw/Roll. Defaults to zero.'),
      scale: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional().describe('Per-axis scale. Defaults to 1,1,1.'),
    })
    .describe('Placement transform. `location` is required; the rest default.'),
});

export const foliageAddInstanceHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('foliage_add_instance', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
