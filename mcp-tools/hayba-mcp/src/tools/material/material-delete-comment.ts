import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'removing a comment box from a material or material-function graph (comment_id from material_get_info.comments[].id)',
  not_when: 'removing a functional node or a named reroute (use material_delete_node — those are expressions)',
};

export const schema = z.object({
  material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
  function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
  comment_id: z.string().min(1).describe('Comment id to delete (from material_get_info.comments[].id or material_add_comment.comment_id)'),
}).refine((d) => !!d.material_path || !!d.function_path, {
  message: 'one of material_path or function_path is required',
});

export async function materialDeleteCommentHandler(args: Record<string, unknown>, _session?: SessionManager): Promise<ToolResult> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_delete_comment', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
