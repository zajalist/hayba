import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'setting brush properties on an Image or Border widget (texture, tint, draw style, image size, 9-slice margin)',
  not_when: 'setting text properties (use ui_set_text_style) or visibility (use ui_set_visibility)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the Image or Border widget'),
  resource: z
    .string()
    .optional()
    .describe('Texture2D or Material asset path for the brush, e.g. "/Game/Aphrosia/UI/Icons/T_RoundedBorder"'),
  tint: z.array(z.number()).length(4).optional().describe('RGBA tint color (0-1)'),
  draw_as: z.enum(['Image', 'Border', 'Mask', 'RoundedBox']).optional().describe('Brush draw style'),
  image_size: z.array(z.number()).length(2).optional().describe('Image size [Width, Height]'),
  margin: z.array(z.number()).length(4).optional().describe('9-slice margins [Left, Top, Right, Bottom]'),
});

export const uiSetBrushHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }

  const { widget_blueprint_path, widget_name, resource, tint, draw_as, image_size, margin } = parsed.data;
  const brush: Record<string, unknown> = {};

  if (resource !== undefined) brush.ResourceObject = { ObjectPath: resource };
  if (tint !== undefined) brush.TintColor = { SpecifiedColor: tint };
  if (draw_as !== undefined) brush.DrawAs = draw_as;
  if (image_size !== undefined) brush.ImageSize = { X: image_size[0], Y: image_size[1] };
  if (margin !== undefined) brush.Margin = { Left: margin[0], Top: margin[1], Right: margin[2], Bottom: margin[3] };

  const data = await executeCommand('ui_set_widget_properties', {
    widget_blueprint_path,
    widget_name,
    properties: { Brush: brush },
  } as Record<string, unknown>);

  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
