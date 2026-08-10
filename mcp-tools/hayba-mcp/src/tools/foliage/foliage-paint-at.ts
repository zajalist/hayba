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
  radius: z.number().finite().positive().max(1_000_000).optional().describe('Brush radius in cm; defaults to 200'),
  density: z.number().int().min(1).max(10_000).optional().describe('Maximum number of placement attempts; defaults to 5'),
  seed: z.number().int().optional().describe('Deterministic scatter seed; defaults to 1337'),
});

export const foliagePaintAtHandler: ToolHandler = ueTool('foliage_paint_at', schema);
