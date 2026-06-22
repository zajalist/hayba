import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'configuring a master material: blend mode, material domain, shading model, two-sided, opacity mask clip value',
  not_when: 'setting parameters on a material instance (use material_set_param) or node properties (use material_set_node)',
};

export const schema = z.object({
  material_path: z.string().min(1).describe('Path to the master material asset'),
  properties: z.record(z.string(), z.unknown())
    .refine((p) => Object.keys(p).length > 0, { message: 'properties must be non-empty' })
    .describe('Material settings. Friendly aliases: domain, blend_mode, shading_model, two_sided, opacity_mask_clip_value (e.g. blend_mode: "BLEND_Translucent"). Any UMaterial UPROPERTY name also accepted.'),
});

export async function materialSetMaterialPropertyHandler(args: Record<string, unknown>, _session?: SessionManager): Promise<ToolResult> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_set_property', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
