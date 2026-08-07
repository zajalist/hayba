import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_level'],
  when: 'scattering foliage over a circular area at a density, the way the paint tool does',
  not_when: 'placing one instance at an exact spot (use foliage_add_instance)',
};

export const schema = z.object({
  foliage_type_path: z.string().min(1).describe('FoliageType asset path to scatter'),
  location: z.object({ x: z.number(), y: z.number(), z: z.number() }).describe('World-space centre of the painted area'),
  radius: z.number().optional().describe('Brush radius in cm'),
  density: z.number().optional().describe('Instances per unit area, as the foliage brush means it'),
});

export const foliagePaintAtHandler: ToolHandler = ueTool('foliage_paint_at', schema);
