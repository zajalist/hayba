import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['moves_actor', 'modifies_level'],
  when: 'repositioning, rotating, or scaling an existing actor',
  not_when: 'spawning new (use actor_spawn) or attaching to a socket (use actor_snap_to_socket)',
};

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const schema = z.object({
  actor_id: z.string().min(1),
  location: vec3.optional(),
  rotation: vec3.optional(),
  scale: vec3.optional(),
});

export const actorTransformHandler: ToolHandler = ueTool('actor_transform', schema);
