import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

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

export const sceneExportHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('scene_export', parsed.data as Record<string, unknown>);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `scene_export failed: ${resp.error ?? 'unknown error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `scene_export error: ${(e as Error).message}` }], isError: true };
  }
};
