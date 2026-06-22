import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['read_only'],
  when: 'inspecting a material or material instance: its properties, parameters, and connected expressions',
  not_when: 'listing multiple materials (use material_list)',
};

export const schema = z.object({
  path: z.string().min(1).describe('Path to the material or material instance to inspect'),
});

export const materialGetInfoHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_get_info', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
