import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'giving a reusable Widget Blueprint a settable property — bind a widget property (Text, ToolTipText, Visibility, bIsEnabled) to a blueprint variable, i.e. the designer "Bind" dropdown',
  not_when: 'setting a one-off literal value (use ui_set_widget_properties or ui_set_text_style)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z
    .string()
    .min(1)
    .describe('Widget whose property is being bound (e.g. "Chip_Label"). Marked Is Variable automatically — a binding cannot resolve otherwise.'),
  property_name: z
    .string()
    .min(1)
    .describe(
      'Bindable property on that widget, WITHOUT the "Delegate" suffix — "Text", "ToolTipText", "Visibility", "bIsEnabled". Rejected with the expected delegate name if the property is not bindable.',
    ),
  variable_name: z
    .string()
    .optional()
    .describe(
      'Blueprint variable to drive the property. Create it first with blueprint_add_variable (type "text" for a Text property). OMIT to CLEAR an existing binding.',
    ),
});

export const uiBindPropertyHandler: ToolHandler = ueTool('ui_bind_property', schema);
