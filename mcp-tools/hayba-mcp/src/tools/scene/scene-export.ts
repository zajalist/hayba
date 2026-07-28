import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';


export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'building a 3D scene graph for the LLM to reason about layout',
  not_when: 'you only need a flat actor list — use actor_list',
};

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const schema = z.object({
  mode: z.enum(['flat', 'relational', 'hierarchical']).optional().default('flat'),
  window: z.object({ min: vec3, max: vec3 }).optional(),
  max_items: z.number().int().optional().default(200),
});

export const sceneExportHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('scene_export', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
