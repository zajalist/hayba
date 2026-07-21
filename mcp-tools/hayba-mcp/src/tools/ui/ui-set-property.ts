import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'setting a single widget property by name with a typed value',
  not_when:
    'setting multiple properties at once (use ui_set_widget_properties) or text/brush/visibility-specific tools',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to set the property on'),
  property_name: z.string().min(1).describe('UE property name to set (e.g. "Text", "ColorAndOpacity", "Visibility")'),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.number())])
    .describe('Property value — string, number, boolean, or array of numbers for colors/vectors'),
});

export const uiSetPropertyHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { property_name, value, ...rest } = parsed.data;
  const data = await executeCommand('ui_set_widget_properties', {
    ...rest,
    properties: { [property_name]: value },
  } as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
