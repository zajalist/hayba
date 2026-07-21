import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'setting one or more widget properties (including slot layout) on an existing widget in a Widget Blueprint',
  not_when: 'setting a single typed property (use ui_set_property) or text styling (use ui_set_text_style)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to set properties on'),
  properties: z
    .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.number())]))
    .optional()
    .describe('Flat or nested property values keyed by UE property name'),
  slot_layout: z
    .object({
      type: z
        .string()
        .optional()
        .describe('Slot type (e.g. "Canvas", "HorizontalBox", "VerticalBox", "Overlay", "Grid")'),
      anchors_min: z.array(z.number()).length(2).optional().describe('Min anchor values [X, Y]'),
      anchors_max: z.array(z.number()).length(2).optional().describe('Max anchor values [X, Y]'),
      position: z.array(z.number()).length(2).optional().describe('Position [X, Y]'),
      size: z.array(z.number()).length(2).optional().describe('Size [Width, Height]'),
      alignment: z.array(z.number()).length(2).optional().describe('Alignment [X, Y] (0-1)'),
      auto_size: z.boolean().optional().describe('Enable auto-sizing'),
      z_order: z.number().int().optional().describe('Z-order'),
    })
    .optional()
    .describe('Slot layout properties (NOT inside properties — sibling field)'),
});

export const uiSetWidgetPropertiesHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_set_widget_properties', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
