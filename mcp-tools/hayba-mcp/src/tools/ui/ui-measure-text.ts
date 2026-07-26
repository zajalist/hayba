import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'finding out how wide a string renders, or how many characters fit in a box, before committing to a layout',
  not_when: 'validating a whole screen (use ui_validate)',
};

export const schema = z.object({
  text: z.string().describe('The string to measure'),

  // Either measure with a live widget's real font...
  widget_blueprint_path: z
    .string()
    .optional()
    .describe('Measure using this blueprint widget’s actual font. Pair with widget_name.'),
  widget_name: z
    .string()
    .optional()
    .describe('Widget whose font (and, by default, box width) to measure against.'),

  // ...or with an explicit font.
  font_asset: z
    .string()
    .optional()
    .describe('Composite UFont asset path. A UFontFace is rejected — Slate cannot measure or render one as text.'),
  font_size: z.number().optional().describe('Font size in px. Required when not measuring against a widget.'),
  typeface: z.string().optional().describe('Typeface name within the font, e.g. "Bold"'),

  available_width: z
    .number()
    .optional()
    .describe('Box width in px to fit against. Defaults to the widget’s laid-out width when a widget is given.'),
  font_scale: z.number().optional().default(1).describe('DPI/application scale to measure at'),
});

export const uiMeasureTextHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const d = parsed.data;
  const hasWidget = Boolean(d.widget_blueprint_path && d.widget_name);
  if (!hasWidget && d.font_size === undefined) {
    return {
      content: [
        {
          type: 'text',
          text: 'Pass either (widget_blueprint_path + widget_name) to measure with a widget’s real font, or font_size (optionally with font_asset) to measure with an explicit one.',
        },
      ],
      isError: true,
    };
  }
  const data = await executeCommand('ui_measure_text', d as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
