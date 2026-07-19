import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['creates_asset'],
  when: 'creating a new material instance derived from a parent material',
  not_when: 'creating a new base material (use material_create)',
};

export const schema = z.object({
  parent_material_path: z.string().min(1).describe('Path to the parent material asset'),
  package_path: z
    .string()
    .min(1)
    .describe('UE content path for the new material instance — the target directory OR the full asset path (either resolves to the same folder)'),
  name: z.string().min(1).describe('Name of the material instance asset'),
});

export const materialCreateInstanceHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_create_instance', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
