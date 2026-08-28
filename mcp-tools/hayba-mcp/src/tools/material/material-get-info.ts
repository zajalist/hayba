import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['read_only'],
  when:
    'inspecting a material or material instance: authored parameter names and typed defaults, exact material-output connections, and connected expressions',
  not_when: 'listing multiple materials (use material_list)',
};

export const schema = z.object({
  path: z.string().min(1).describe('Path to the material or material instance to inspect'),
});

export const materialGetInfoHandler: ToolHandler = ueTool('material_get_info', schema);
