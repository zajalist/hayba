import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'discovering actors in the live PIE world before inspecting or clicking a runtime object',
  not_when: 'enumerating the editor level outside PIE (use actor_list)',
};

export const schema = z
  .object({
    pie_instance: z
      .number()
      .int()
      .min(0)
      .max(1024)
      .optional()
      .describe('Select a PIE client/server from available_worlds. Omit for the sole or active world.'),
    class_filter: z.string().max(256).optional().describe('Case-insensitive substring of class name or class path.'),
    name_filter: z.string().max(256).optional().describe('Case-insensitive substring of runtime actor id or label.'),
    tag: z.string().max(256).optional().describe('Exact actor tag.'),
    offset: z.number().int().min(0).max(9_999).optional().default(0),
    limit: z.number().int().min(1).max(50).optional().default(50),
  })
  .strict();

export const pieActorListHandler: ToolHandler = ueTool('editor_pie_actor_list', schema);
