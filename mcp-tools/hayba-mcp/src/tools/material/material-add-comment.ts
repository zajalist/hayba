import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'adding a titled comment box around a group of nodes in a material or material-function graph',
  not_when: 'adding a functional node (use material_add_node)',
};

export const schema = z.object({
  material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
  function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
  text: z.string().describe('Comment title/text shown on the box'),
  node_pos: z.tuple([z.number(), z.number()]).optional().describe('Top-left graph position [x, y]'),
  size: z.tuple([z.number(), z.number()]).optional().describe('Box size [width, height]'),
  color: z.array(z.number()).min(3).max(4).optional().describe('Box color [r, g, b] or [r, g, b, a] (0..1)'),
  font_size: z.number().int().optional().describe('Title font size (default 18)'),
}).refine((d) => !!d.material_path || !!d.function_path, {
  message: 'one of material_path or function_path is required',
});

export const materialAddCommentHandler: ToolHandler = ueTool('material_add_comment', schema);
