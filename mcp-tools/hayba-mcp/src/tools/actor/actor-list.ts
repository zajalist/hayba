import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'enumerating actors currently in the active level',
  not_when: 'looking up a specific known actor — query it directly',
};

export const schema = z.object({
  class_filter: z.string().optional(),
  tag: z.string().optional(),
});

export const actorListHandler: ToolHandler = ueTool('actor_list', schema);
