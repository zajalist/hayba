import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'copying an existing widget — with its children, properties and slot layout — to build repeated rows or cards',
  not_when: 'creating a fresh widget from a class (use ui_add_element)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to duplicate. Its whole subtree is copied.'),
  new_name: z.string().optional().describe('Name for the copy. Auto-uniquified from the source name if omitted.'),
  parent_widget_name: z
    .string()
    .optional()
    .describe('Panel to place the copy under. Defaults to the source widget own parent (i.e. a sibling copy).'),
  slot_props: z
    .record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.array(z.number())]))
    .optional()
    .describe('Slot layout overrides for the copy, applied after the source slot layout is cloned.'),
});

export const uiDuplicateElementHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_mutate_tree', {
    operation: 'duplicate',
    ...parsed.data,
  } as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
