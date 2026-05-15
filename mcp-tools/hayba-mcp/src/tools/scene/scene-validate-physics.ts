import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'checking for floating or interpenetrating actors before publishing a level',
  not_when: 'you only need a count — use scene_export',
};

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const schema = z.object({
  deep_check: z.boolean().optional().default(false),
  window: z.object({ min: vec3, max: vec3 }).optional(),
});

export function metaFor(args: { deep_check?: boolean }): HaybaToolMeta {
  return { ...meta, cost: args.deep_check ? 'high' : 'medium' };
}

export const sceneValidatePhysicsHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const resp = await client.send('scene_validate_physics', parsed.data as Record<string, unknown>);
    if (!resp.ok) {
      return { content: [{ type: 'text', text: `scene_validate_physics failed: ${resp.error ?? 'unknown error'}` }], isError: true };
    }
    let text = JSON.stringify(resp.data, null, 2);
    if (parsed.data.deep_check && resp.data && (resp.data as Record<string, unknown>).deep_check_required === true) {
      text += `\n\nDeep check requested — relay payload to visual sidecar at SidecarURL/validate (not implemented in this version)`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `scene_validate_physics error: ${(e as Error).message}` }], isError: true };
  }
};
