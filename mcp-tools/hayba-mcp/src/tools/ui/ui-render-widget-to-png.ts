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

/**
 * True only for a well-formed, complete base64 string (correct charset, and a
 * length that is a multiple of 4 once padding is accounted for).
 *
 * Why this matters here: the response-shaping layer between UE and this
 * handler (a generic string-length cap applied to every field in every
 * command's JSON response) can clip a long string field before it reaches
 * this handler — see docs/handoffs/HANDOFF-mcp-agent-ergonomics-postmortem.md
 * for the `_truncated`/`removed` signature this produces on a sibling tool.
 * A clipped base64 string is non-empty but invalid: cutting it mid-stream
 * both breaks the 4-char alignment and appends a non-base64 "..." marker.
 *
 * Handing an invalid string to the MCP SDK as an `image` content block throws
 * deep inside the SDK's own result validation ("Invalid Base64 string") —
 * which fails the ENTIRE tool response, taking the metadata and `path` down
 * with it even though both are fine. Validating first means a corrupted
 * field degrades to "no inline image" instead of "no response at all".
 */
export function isValidBase64(s: string): boolean {
  if (s.length === 0 || s.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(s);
}

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

  // Always surface a `path` a caller can read from disk. A file path cannot be
  // corrupted by a response-shaping layer the way an inline base64 string
  // can, so it is the robust fallback regardless of what happened to
  // image_base64. `out_path` is UE's field name; `path` is the stable alias
  // callers should prefer.
  const rawPath = (metaFields as Record<string, unknown>).out_path;
  const path = typeof rawPath === 'string' && rawPath.length > 0 ? rawPath : undefined;
  const meta: Record<string, unknown> = path !== undefined ? { ...metaFields, path } : { ...metaFields };

  const content: RichToolResult['content'] = [{ type: 'text', text: JSON.stringify(meta, null, 2) }];

  if (typeof image_base64 === 'string' && image_base64.length > 0) {
    if (isValidBase64(image_base64)) {
      content.unshift({ type: 'image', data: image_base64, mimeType: 'image/png' });
    } else {
      // Corrupted/clipped payload — never construct an image block from it.
      // Report the problem as text instead so the caller still gets metadata
      // and `path`, and knows to fall back to reading the file.
      content.push({
        type: 'text',
        text:
          `image_base64 was present but not valid base64 (length ${image_base64.length}) — ` +
          `it was likely clipped by response shaping before reaching this tool. ` +
          `Read the PNG from "path" instead.`,
      });
    }
  }

  return { content };
};
