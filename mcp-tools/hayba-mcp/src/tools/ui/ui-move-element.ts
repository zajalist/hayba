import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { resolveAliases } from '../param-aliases.js';
import { TOOL_ALIASES } from '../tool-aliases.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'reordering a widget among its siblings — child order is draw order and tab order in box panels',
  not_when: 'moving a widget to a DIFFERENT parent (use ui_reparent_element)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to reorder'),
  index: z
    .number()
    .int()
    .min(0)
    .describe('New zero-based index among its siblings. Out-of-range values are rejected with the valid range.'),
});

export const uiMoveElementHandler: ToolHandler = async (args) => {
  const resolved = resolveAliases(args, TOOL_ALIASES.ui_move_element);
  if (!resolved.ok) {
    return { content: [{ type: 'text', text: `Validation error: ${resolved.error}` }], isError: true };
  }
  const parsed = schema.safeParse(resolved.args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_mutate_tree', {
    operation: 'move',
    ...parsed.data,
  } as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
