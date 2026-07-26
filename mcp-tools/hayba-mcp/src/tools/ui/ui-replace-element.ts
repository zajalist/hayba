import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'replacing a widget with a different widget class while optionally preserving its GUID and/or properties',
  not_when: 'removing a widget (use ui_remove_element) or reparenting (use ui_reparent_element)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to replace'),
  new_class: z.string().min(1).describe('New widget class to replace with (short name or full class path)'),
  new_name: z.string().optional().describe('New name for the replacement widget (defaults to original name)'),
  preserve_guid: z.boolean().optional().default(true).describe('Preserve the original widget GUID'),
  preserve_properties: z
    .boolean()
    .optional()
    .default(false)
    .describe('Preserve original widget properties on the replacement'),
});

export const uiReplaceElementHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_mutate_tree', {
    operation: 'replace',
    ...parsed.data,
  } as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
