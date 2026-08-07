import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['destroys_actor', 'modifies_level'],
  when: 'removing an actor from the level',
  not_when: 'hiding it temporarily — use actor_set_visibility',
};

export const schema = z.object({
  actor_id: z.string().min(1),
});

export const actorDeleteHandler: ToolHandler = ueTool('actor_delete', schema);
