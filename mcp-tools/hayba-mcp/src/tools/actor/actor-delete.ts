import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['destroys_actor', 'modifies_level'],
  when: 'removing an actor from the level',
  not_when: 'hiding it temporarily — use actor_set_visibility',
};

export const schema = z.object({
  actor_id: z.string().min(1),
});

export const actorDeleteHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  return executeCommand('actor_delete', parsed.data as Record<string, unknown>);
};
