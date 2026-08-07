import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'finding meshes with no LODs, excessive triangles, or too many material slots',
  not_when: 'you want per-instance placement data (use pcg_inspect_instances or actor_list)',
};

export const schema = z.object({
  top_n: z
    .number()
    .int()
    .optional()
    .describe('How many of the heaviest meshes to return. Default 25, max 500.'),
});

export const meshAuditHandler: ToolHandler = ueTool('mesh_audit', schema);
