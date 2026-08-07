import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['read_only'],
  when: 'listing materials and material instances in the project or a specific path',
  not_when: 'inspecting detailed properties of a specific material (use material_get_info)',
};

export const schema = z.object({
  path: z.string().optional().describe('UE content path filter (default: list all)'),
});

export const materialListHandler: ToolHandler = ueTool('material_list', schema);
