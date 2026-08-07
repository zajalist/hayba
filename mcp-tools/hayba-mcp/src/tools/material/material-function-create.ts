import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['creates_asset'],
  when: 'creating a new material function asset in the project',
  not_when: 'creating a material (use material_create) or material instance (use material_create_instance)',
};

export const schema = z.object({
  package_path: z
    .string()
    .min(1)
    .describe(
      'package_path may be the target directory (e.g. "/Game/Dir/MFs") OR the full asset path (e.g. "/Game/Dir/MFs/MF_X"); either resolves to the same folder',
    ),
  name: z.string().min(1).describe('Name of the material function asset'),
});

export const materialFunctionCreateHandler: ToolHandler = ueTool('material_function_create', schema);
