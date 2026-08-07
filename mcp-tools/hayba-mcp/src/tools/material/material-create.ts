import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['creates_asset'],
  when: 'creating a new material asset in the project',
  not_when: 'duplicating an existing material (use asset_duplicate)',
};

export const schema = z.object({
  package_path: z
    .string()
    .min(1)
    .describe('UE content path for the new material — the target directory OR the full asset path (either resolves to the same folder)'),
  name: z.string().min(1).describe('Name of the material asset'),
});

export const materialCreateHandler: ToolHandler = ueTool('material_create', schema);
