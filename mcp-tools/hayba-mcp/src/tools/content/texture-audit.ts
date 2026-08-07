import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'finding which textures are actually costing memory, and which are compressed wrongly for their role',
  not_when: 'inspecting one texture you already know about (use texture_get_info)',
};

export const schema = z.object({
  top_n: z
    .number()
    .int()
    .optional()
    .describe('How many of the heaviest textures to return. Default 25, max 500. The scan covers every Texture2D regardless.'),
});

export const textureAuditHandler: ToolHandler = ueTool('texture_audit', schema);
