import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'reparenting a widget to a new parent panel in the Widget Blueprint tree',
  not_when: 'removing a widget (use ui_remove_element) or replacing a widget class (use ui_replace_element)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to reparent'),
  new_parent_name: z.string().min(1).describe('Name of the existing panel widget to reparent under'),
  slot_props: z
    .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
    .optional()
    .describe('Optional slot layout props for the new parent slot'),
});

export const uiReparentElementHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_mutate_tree', {
    operation: 'reparent',
    ...parsed.data,
  } as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
