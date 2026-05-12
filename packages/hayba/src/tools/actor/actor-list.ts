import { z } from 'zod';
import type { ToolHandler } from '../hayba-bake-terrain.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

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

export const actorListHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('actor_list', parsed.data as Record<string, unknown>);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `actor_list failed: ${resp.error ?? 'unknown error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `actor_list error: ${(e as Error).message}` }], isError: true };
  }
};
