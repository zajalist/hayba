import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';


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
    const data = await executeCommand<Record<string, unknown>>(
      'scene_validate_physics',
      parsed.data as Record<string, unknown>,
    );
    let text = JSON.stringify(data, null, 2);
    if (parsed.data.deep_check && data && data.deep_check_required === true) {
      text += `\n\nDeep check requested — relay payload to visual sidecar at SidecarURL/validate (not implemented in this version)`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (e: unknown) {
    return { content: [{ type: 'text', text: `scene_validate_physics error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
};
