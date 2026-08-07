import { z } from 'zod';
import type { RichToolHandler, RichToolResult } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  // Writes a PNG and nothing else — no asset, no scene, no widget state.
  effects: ['filesystem_write'],
  when: 'you want to SEE what a Widget Blueprint looks like — fonts, colours, brushes, spacing, overflow',
  not_when: 'you need numbers rather than an image (ui_layout_snapshot) or the problems (ui_validate)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the Widget Blueprint to draw'),
  width: z.number().optional().describe('Render width in px. Defaults to the blueprint’s design-time size.'),
  height: z.number().optional().describe('Render height in px. Defaults to the blueprint’s design-time size.'),
  scale: z.number().optional().describe('Multiplies the size, 0.1–4.0. Use 2 to read small text.'),
  out_path: z
    .string()
    .optional()
    .describe('Where to write the PNG. Defaults to Saved/Screenshots/Hayba/. Relative paths resolve against the project.'),
  opaque_background: z
    .boolean()
    .optional()
    .describe(
      'Force alpha to 255 (default true). UMG draws onto transparency, and an unmodified alpha channel makes most viewers show the whole image as black. Pass false only when you intend to composite.',
    ),
  inline_image: z
    .boolean()
    .optional()
    .describe('Return the PNG inline so you can actually look at it (default true). Skipped automatically above ~3MB; read out_path in that case.'),
});

// Rich rather than plain: this tool returns an image block, which the text-only
// ToolResult cannot carry. Signature otherwise matches every other handler.
export const uiRenderWidgetToPngHandler: RichToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }

  const data = await executeCommand<Record<string, unknown>>(
    'ui_render_widget_to_png',
    parsed.data as Record<string, unknown>,
  );

  // Split the payload: the image goes in a proper MCP image block and the
  // metadata stays a small text block. Serialising a multi-MB base64 string
  // into the text block is what destroyed every screenshot the last time —
  // the transport length-caps text. See editor_capture_viewport.
  const { image_base64, ...metaFields } = data as { image_base64?: unknown } & Record<string, unknown>;
  const content: RichToolResult['content'] = [{ type: 'text', text: JSON.stringify(metaFields, null, 2) }];

  if (typeof image_base64 === 'string' && image_base64.length > 0) {
    content.unshift({ type: 'image', data: image_base64, mimeType: 'image/png' });
  }

  return { content };
};
