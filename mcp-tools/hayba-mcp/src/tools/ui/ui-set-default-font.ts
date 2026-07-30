import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['modifies_asset'],
  when: 'a Widget Blueprint still has text in the engine default font and you want the project font everywhere',
  not_when: 'restyling one specific widget (ui_set_text_style) or changing size/colour rather than the font family',
};

/**
 * Every TextBlock created through ui_build_tree, ui_add_element or
 * NewObject<UTextBlock> arrives as /Engine/EngineFonts/Roboto "Bold". It is
 * invisible until the widget renders, and ui_set_text_style only changes the
 * fields you pass — so setting size and colour but forgetting font_asset and
 * typeface silently keeps Roboto and still reports success.
 *
 * The UI postmortem hit this five separate times in one session. Fixing it one
 * widget at a time is the slow half; this walks the blueprint and rewrites
 * every text widget still on an engine font in a single call.
 */
export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the Widget Blueprint to sweep'),
  font_asset: z
    .string()
    .min(1)
    .describe('Composite UFont asset to apply, e.g. "/Game/UI/Fonts/F_AphrosiaBody". Must NOT be a UFontFace.'),
  typeface: z
    .string()
    .optional()
    .default('Regular')
    .describe('Typeface within the font. Defaults to Regular — the engine default is Bold, which reads as emphasis nobody asked for.'),
  only_engine_fonts: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Only rewrite text that is still on an /Engine/ font (the default). Set false to force every text widget onto this font, including ones deliberately styled otherwise.',
    ),
  dry_run: z
    .boolean()
    .optional()
    .default(false)
    .describe('Report what would change without writing anything.'),
});

interface SnapshotWidget {
  name: string;
  class?: string;
  text_info?: { font_object?: string; typeface?: string };
}

export const uiSetDefaultFontHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { widget_blueprint_path, font_asset, typeface, only_engine_fonts, dry_run } = parsed.data;

  // The snapshot is the only thing that knows which widgets actually render
  // text and what font each resolved to. Walking the tree by class would miss
  // buttons-with-text and rich text.
  const snapshot = await executeCommand<{
    layout_resolved?: boolean;
    layout_error?: string;
    widgets?: SnapshotWidget[];
  }>('ui_layout_snapshot', { widget_blueprint_path });

  const widgets = snapshot.widgets ?? [];
  const candidates = widgets.filter((w) => {
    const font = w.text_info?.font_object;
    if (!font) return false;
    if (!only_engine_fonts) return true;
    return /^\/Engine\//i.test(font);
  });

  if (candidates.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              widget_blueprint_path,
              changed: [],
              changed_count: 0,
              // Distinguish "nothing needed changing" from "nothing could be
              // examined" — a blueprint that failed to instantiate reports zero
              // text widgets, which would otherwise read as a clean sweep.
              note: snapshot.layout_resolved === false
                ? `No text widgets could be examined: the blueprint did not lay out (${snapshot.layout_error ?? 'unknown reason'}). Compile it first — this is NOT a clean result.`
                : only_engine_fonts
                  ? 'No text widgets are on an engine font. Nothing to do.'
                  : 'No text widgets found.',
              text_widgets_examined: widgets.filter((w) => w.text_info?.font_object).length,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (dry_run) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              widget_blueprint_path,
              dry_run: true,
              would_change: candidates.map((w) => ({ widget: w.name, from: w.text_info?.font_object })),
              would_change_count: candidates.length,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  const changed: Array<{ widget: string; from?: string }> = [];
  const failed: Array<{ widget: string; error: string }> = [];

  for (const w of candidates) {
    try {
      // font_asset AND typeface together, always: passing one without the other
      // is the exact mistake this tool exists to undo.
      await executeCommand('ui_set_text_style', {
        widget_blueprint_path,
        widget_name: w.name,
        font_asset,
        typeface,
      });
      changed.push({ widget: w.name, from: w.text_info?.font_object });
    } catch (e) {
      failed.push({ widget: w.name, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            widget_blueprint_path,
            font_asset,
            typeface,
            changed,
            changed_count: changed.length,
            failed,
            failed_count: failed.length,
            note: 'Staged only. Call ui_compile_widget then ui_save_widget to persist, and ui_render_widget_to_png to look at the result.',
          },
          null,
          2,
        ),
        },
    ],
    isError: failed.length > 0 && changed.length === 0,
  };
};
