import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
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

export const sceneExportHandler: ToolHandler = ueTool('scene_export', schema);
