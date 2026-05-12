import { z } from 'zod';
import type { ToolHandler } from '../hayba-bake-terrain.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

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

export const actorSpawnHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('actor_spawn', parsed.data as Record<string, unknown>);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `actor_spawn failed: ${resp.error ?? 'unknown error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `actor_spawn error: ${(e as Error).message}` }], isError: true };
  }
};
