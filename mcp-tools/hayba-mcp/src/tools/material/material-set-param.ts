import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'setting a scalar, vector (rgba), or texture parameter on a material instance',
  not_when: 'applying a material to an actor (use material_apply)',
};

export const schema = z.object({
  instance_path: z.string().min(1).describe('Path to the material instance'),
  param_name: z.string().min(1).describe('Name of the parameter to set'),
  value: z.union([
    z.number().describe('Scalar value'),
    z.array(z.number()).min(1).max(4).describe('Vector value (1-4 components for rgba)'),
    z.string().describe('Texture asset path'),
  ]).describe('Parameter value: scalar, vector (1-4 elements), or texture asset path'),
});

export const materialSetParamHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_set_param', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
