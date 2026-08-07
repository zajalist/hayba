import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_level'],
  when: 'applying a material to an actor in the level (optionally specifying a material slot)',
  not_when: 'setting parameters on a material instance (use material_set_param)',
};

export const schema = z.object({
  actor_id: z.string().min(1).describe('ID of the actor to apply the material to'),
  material_path: z.string().min(1).describe('Path to the material asset to apply'),
  slot_index: z.number().int().nonnegative().optional().describe('Material slot index (default 0)'),
});

export const materialApplyHandler: ToolHandler = ueTool('material_apply', schema);
