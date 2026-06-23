import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'editing an existing comment box — move/resize/retitle/recolor it (comment_id from material_get_info.comments[].id)',
  not_when: 'creating a comment (material_add_comment) or removing one (material_delete_comment)',
};

export const schema = z.object({
  material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
  function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
  comment_id: z.string().min(1).describe('Comment id to edit (from material_get_info.comments[].id)'),
  text: z.string().optional().describe('New title/text'),
  node_pos: z.tuple([z.number(), z.number()]).optional().describe('New top-left graph position [x, y]'),
  size: z.tuple([z.number(), z.number()]).optional().describe('New box size [width, height]'),
  color: z.array(z.number()).min(3).max(4).optional().describe('New color [r, g, b] or [r, g, b, a] (0..1)'),
  font_size: z.number().int().optional().describe('New title font size'),
}).refine((d) => !!d.material_path || !!d.function_path, {
  message: 'one of material_path or function_path is required',
});

export async function materialSetCommentHandler(args: Record<string, unknown>, _session?: SessionManager): Promise<ToolResult> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_set_comment', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
