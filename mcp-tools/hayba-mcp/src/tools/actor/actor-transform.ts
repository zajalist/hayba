import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

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

export const actorTransformHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('actor_transform', parsed.data as Record<string, unknown>);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `actor_transform failed: ${resp.error ?? 'unknown error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e: unknown) {
    return { content: [{ type: 'text', text: `actor_transform error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
};
