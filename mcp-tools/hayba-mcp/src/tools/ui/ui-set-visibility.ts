import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'changing the visibility of a widget (Visible, Hidden, Collapsed, HitTestInvisible, SelfHitTestInvisible)',
  not_when: 'setting other widget properties (use ui_set_widget_properties)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to change visibility on'),
  visibility: z
    .enum(['Visible', 'Hidden', 'Collapsed', 'HitTestInvisible', 'SelfHitTestInvisible'])
    .describe('New visibility state'),
});

export const uiSetVisibilityHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_set_widget_properties', {
    widget_blueprint_path: parsed.data.widget_blueprint_path,
    widget_name: parsed.data.widget_name,
    properties: { Visibility: parsed.data.visibility },
  } as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
