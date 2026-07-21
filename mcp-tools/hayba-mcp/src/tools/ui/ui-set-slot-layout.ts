import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'setting canvas slot layout on a widget (anchors, position, size, alignment, z-order)',
  not_when: 'setting widget properties like text/brush/visibility (use the typed convenience tools)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget to set slot layout on'),
  anchors_min: z.array(z.number()).length(2).optional().describe('Min anchor values [X, Y]'),
  anchors_max: z.array(z.number()).length(2).optional().describe('Max anchor values [X, Y]'),
  position: z.array(z.number()).length(2).optional().describe('Position [X, Y]'),
  size: z.array(z.number()).length(2).optional().describe('Size [Width, Height]'),
  alignment: z.array(z.number()).length(2).optional().describe('Alignment [X, Y] (0-1)'),
  auto_size: z.boolean().optional().describe('Enable auto-sizing'),
  z_order: z.number().int().optional().describe('Z-order'),
});

export const uiSetSlotLayoutHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }

  const { widget_blueprint_path, widget_name, ...slotFields } = parsed.data;
  const slot_layout: Record<string, unknown> = { type: 'Canvas' };

  if (slotFields.anchors_min !== undefined) slot_layout.anchors_min = slotFields.anchors_min;
  if (slotFields.anchors_max !== undefined) slot_layout.anchors_max = slotFields.anchors_max;
  if (slotFields.position !== undefined) slot_layout.position = slotFields.position;
  if (slotFields.size !== undefined) slot_layout.size = slotFields.size;
  if (slotFields.alignment !== undefined) slot_layout.alignment = slotFields.alignment;
  if (slotFields.auto_size !== undefined) slot_layout.auto_size = slotFields.auto_size;
  if (slotFields.z_order !== undefined) slot_layout.z_order = slotFields.z_order;

  const data = await executeCommand('ui_set_widget_properties', {
    widget_blueprint_path,
    widget_name,
    slot_layout,
  } as Record<string, unknown>);

  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
