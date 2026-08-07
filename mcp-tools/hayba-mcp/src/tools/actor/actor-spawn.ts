import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['spawns_actor', 'modifies_level'],
  when: 'placing a new asset instance in the active level',
  not_when: 'duplicating an existing actor (use actor_duplicate) or just moving one (actor_transform)',
};

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const schema = z.object({
  class_path: z.string().min(1),
  location: vec3.optional(),
  rotation: vec3.optional(),
  scale: vec3.optional(),
  label: z.string().optional(),
});

export const actorSpawnHandler: ToolHandler = ueTool('actor_spawn', schema);
