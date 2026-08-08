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
  // The spelling every caller reaches for first. Before this existed, zod's
  // default strip mode silently DELETED an `anchors` argument on the way to
  // UE, the other fields applied, the tool reported success — and the field
  // conclusion was "ui_set_slot_layout anchors are a silent no-op", worked
  // around with object_set_property + a full LayoutData literal.
  anchors: z
    .union([
      z.array(z.number()).length(4),
      z.object({
        min: z.array(z.number()).length(2),
        max: z.array(z.number()).length(2),
      }),
    ])
    .optional()
    .describe('Canvas: anchors as [minX, minY, maxX, maxY] or {min:[x,y], max:[x,y]}. Sugar for anchors_min + anchors_max.'),
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
  // .strict() so a misspelled or invented layout field is a loud validation
  // error naming the key, instead of being stripped and reported as success.
  // Silent stripping is precisely how the anchors defect above stayed
  // undiagnosed for weeks.
}).strict();

export const uiSetSlotLayoutHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }

  const { widget_blueprint_path, widget_name, anchors, ...slotFields } = parsed.data;

  // Only forward keys the caller actually set. Sending undefined entries would
  // make the handler report them as unknown slot props.
  const slot_props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slotFields)) {
    if (value !== undefined) slot_props[key] = value;
  }

  // Normalize the `anchors` sugar onto the two fields the C++ handler reads.
  // Explicit anchors_min/anchors_max win if both spellings are present.
  if (anchors !== undefined) {
    const [min, max] = Array.isArray(anchors)
      ? [[anchors[0]!, anchors[1]!], [anchors[2]!, anchors[3]!]]
      : [anchors.min, anchors.max];
    slot_props.anchors_min ??= min;
    slot_props.anchors_max ??= max;
  }

  if (Object.keys(slot_props).length === 0) {
    return {
      content: [{ type: 'text', text: 'Nothing to do: pass at least one slot layout field.' }],
      isError: true,
    };
  }

  // The UE handler reads `slot_props`. This tool used to send `slot_layout`,
  // which no handler revision ever read, so every call failed outright as
  // having sent no payload. The handler now accepts all three spellings and
  // names the one it read back (HaybaUIOps::ResolveSlotProps); keep sending the
  // documented one so the reply stays silent about it.
  const data = await executeCommand('ui_set_widget_properties', {
    widget_blueprint_path,
    widget_name,
    slot_props,
  } as Record<string, unknown>);

  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
