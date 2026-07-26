import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'exposing a widget as a blueprint variable so the graph (or a C++ BindWidget) can reach it',
  not_when: 'renaming the widget (use ui_rename_element)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to expose or hide'),
  is_variable: z
    .boolean()
    .optional()
    .default(true)
    .describe('true exposes the widget as a variable (the designer "Is Variable" checkbox); false hides it again.'),
  category: z.string().optional().describe('Variable category shown in the blueprint variable list'),
});

export const uiSetVariableHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_set_variable', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
