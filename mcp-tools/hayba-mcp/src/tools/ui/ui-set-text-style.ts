import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'styling a TextBlock widget (text content, font, color, justification, outline, shadow)',
  not_when: 'setting non-text properties (use ui_set_widget_properties) or setting brush/tint (use ui_set_brush)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the target Widget Blueprint'),
  widget_name: z.string().min(1).describe('Name of the TextBlock widget to style'),
  text: z.string().optional().describe('Text content to display'),
  font_asset: z
    .string()
    .optional()
    .describe(
      'Path to a composite UFont asset, e.g. "/Game/UI/Fonts/Cormorant". Must NOT be a UFontFace — Slate renders a raw font face as its glyph-preview tiles instead of as text, and the handler warns when it sees one.',
    ),
  typeface: z.string().optional().describe('Font typeface name (e.g. "Regular", "Bold", "Italic")'),
  size: z.number().optional().describe('Font size in points'),
  letter_spacing: z.number().optional().describe('Letter spacing value'),
  color: z.array(z.number()).length(4).optional().describe('Text color as RGBA (0-1)'),
  outline_size: z.number().optional().describe('Outline size'),
  outline_color: z.array(z.number()).length(4).optional().describe('Outline color as RGBA (0-1)'),
  shadow_offset: z.array(z.number()).length(2).optional().describe('Shadow offset [X, Y]'),
  shadow_color: z.array(z.number()).length(4).optional().describe('Shadow color as RGBA (0-1)'),
  justification: z.enum(['Left', 'Center', 'Right']).optional().describe('Text justification'),
});

export const uiSetTextStyleHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }

  const {
    widget_blueprint_path,
    widget_name,
    text,
    font_asset,
    typeface,
    size,
    letter_spacing,
    color,
    outline_size,
    outline_color,
    shadow_offset,
    shadow_color,
    justification,
  } = parsed.data;
  const properties: Record<string, unknown> = {};

  if (text !== undefined) properties.Text = text;
  if (letter_spacing !== undefined) properties.LetterSpacing = letter_spacing;
  if (color !== undefined) properties.ColorAndOpacity = color;
  if (justification !== undefined) properties.Justification = justification;

  if (font_asset !== undefined || size !== undefined || typeface !== undefined) {
    const font: Record<string, unknown> = {};
    if (font_asset !== undefined) font.FontObject = font_asset;
    if (size !== undefined) font.Size = size;
    if (typeface !== undefined) font.TypefaceFontName = typeface;
    properties.Font = font;
  }

  if (outline_size !== undefined || outline_color !== undefined) {
    const outline: Record<string, unknown> = {};
    if (outline_size !== undefined) outline.OutlineSize = outline_size;
    if (outline_color !== undefined) outline.OutlineColor = outline_color;
    properties.OutlineSettings = outline;
  }

  if (shadow_offset !== undefined || shadow_color !== undefined) {
    const shadow: Record<string, unknown> = {};
    if (shadow_offset !== undefined) shadow.ShadowOffset = shadow_offset;
    if (shadow_color !== undefined) shadow.ShadowColorAndOpacity = shadow_color;
    properties.ShadowSettings = shadow;
  }

  const data = await executeCommand('ui_set_widget_properties', {
    widget_blueprint_path,
    widget_name,
    properties,
  } as Record<string, unknown>);

  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
