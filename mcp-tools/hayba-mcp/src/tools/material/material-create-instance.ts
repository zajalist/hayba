import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
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

export const materialCreateInstanceHandler: ToolHandler = ueTool('material_create_instance', schema);
