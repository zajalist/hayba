import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'positioning a widget inside its parent panel (canvas anchors/position/size, or box padding/fill/alignment)',
  not_when: 'setting widget properties like text/brush/visibility (use the typed convenience tools)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the widget whose SLOT is being laid out'),

  // Canvas slot
  anchors_min: z.array(z.number()).length(2).optional().describe('Canvas: min anchor [X, Y] in 0-1 screen fractions'),
  anchors_max: z.array(z.number()).length(2).optional().describe('Canvas: max anchor [X, Y] in 0-1 screen fractions'),
  position: z.array(z.number()).length(2).optional().describe('Canvas: position [X, Y] in px relative to the anchor'),
  size: z.array(z.number()).length(2).optional().describe('Canvas: size [Width, Height] in px'),
  alignment: z.array(z.number()).length(2).optional().describe('Canvas: pivot [X, Y] in 0-1 (0.5,0.5 centres on the position)'),
  auto_size: z.boolean().optional().describe('Canvas: size to the widget’s desired size instead of the explicit size'),
  z_order: z.number().int().optional().describe('Canvas: draw order among siblings (higher draws on top)'),

  // Box / grid / overlay slots
  padding: z
    .union([z.number(), z.array(z.number()).length(4), z.object({
      left: z.number().optional(),
      top: z.number().optional(),
      right: z.number().optional(),
      bottom: z.number().optional(),
    })])
    .optional()
    .describe('Box/grid/overlay/border/size-box slots: padding as a single number, [L,T,R,B], or {left,top,right,bottom}. Zero is honoured, so this can clear padding.'),
  fill: z.number().optional().describe('Horizontal/VerticalBox slots: fill weight. 0 means size-to-content.'),
  horizontal_alignment: z.enum(['Fill', 'Left', 'Center', 'Right']).optional().describe('Alignment within the slot'),
  vertical_alignment: z.enum(['Fill', 'Top', 'Center', 'Bottom']).optional().describe('Alignment within the slot'),

  // Grid slots
  row: z.number().int().optional().describe('Grid/UniformGrid slots: row index'),
  column: z.number().int().optional().describe('Grid/UniformGrid slots: column index'),
  row_span: z.number().int().optional().describe('Grid slots: rows spanned'),
  column_span: z.number().int().optional().describe('Grid slots: columns spanned'),
});

export const uiSetSlotLayoutHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }

  const { widget_blueprint_path, widget_name, ...slotFields } = parsed.data;

  // Only forward keys the caller actually set. Sending undefined entries would
  // make the handler report them as unknown slot props.
  const slot_props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slotFields)) {
    if (value !== undefined) slot_props[key] = value;
  }

  if (Object.keys(slot_props).length === 0) {
    return {
      content: [{ type: 'text', text: 'Nothing to do: pass at least one slot layout field.' }],
      isError: true,
    };
  }

  // The UE handler reads `slot_props`. This tool used to send `slot_layout`,
  // which no handler revision ever read, so every call failed outright with
  // "no properties or slot_props provided".
  const data = await executeCommand('ui_set_widget_properties', {
    widget_blueprint_path,
    widget_name,
    slot_props,
  } as Record<string, unknown>);

  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
