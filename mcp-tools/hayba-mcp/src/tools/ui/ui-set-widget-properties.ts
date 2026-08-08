import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'setting one or more widget properties (and/or its slot layout) on an existing widget in a Widget Blueprint',
  not_when: 'setting a single typed property (use ui_set_property) or text styling (use ui_set_text_style)',
};

// UE property values can nest arbitrarily: FSlateBrush contains an FSlateColor
// which contains an FLinearColor. The handler applies nested JSON objects field
// by field via reflection, so the schema must not flatten them away.
const propertyValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(propertyValue), z.record(z.string(), propertyValue)]),
);

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to set properties on'),
  properties: z
    .record(z.string(), propertyValue)
    .optional()
    .describe(
      'Property values keyed by their real UE property name (e.g. "Text", "ColorAndOpacity", "Font"). Values may be nested objects for struct properties, arrays for colors/vectors, or an asset path string for object references.',
    ),
  slot_props: z
    .record(z.string(), propertyValue)
    .optional()
    .describe(
      'Layout properties applied to the widget’s PANEL SLOT rather than the widget: canvas (anchors/position/size/alignment/auto_size/z_order), box (fill/padding/alignment), grid (row/column/spans). Keys the slot type does not support come back in unknown_slot_props instead of being silently dropped.',
    ),
});

export const uiSetWidgetPropertiesHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  if (parsed.data.properties === undefined && parsed.data.slot_props === undefined) {
    return {
      content: [{ type: 'text', text: 'Nothing to do: pass `properties`, `slot_props`, or both.' }],
      isError: true,
    };
  }
  const data = await executeCommand('ui_set_widget_properties', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
