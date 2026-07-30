import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['modifies_asset'],
  when: '"make this look like that one" — copying a working widget\'s brush and/or text style onto another',
  not_when: 'you know the exact values you want (ui_set_brush / ui_set_text_style) or want to copy the widget itself (ui_duplicate_element)',
};

/**
 * "Make this modal look like that working modal" is the most common styling
 * intent there is, and it used to require discovering the working widget's
 * brush by hand — which was impossible through the UI tools until brush_info
 * started reporting draw_as, resource and margin.
 *
 * Deliberately copies STYLE only, never geometry or content: slot layout and
 * text belong to the target, and quietly overwriting them is how a "just make
 * it match" turns into a wrecked layout.
 */
export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Blueprint containing the source widget'),
  from_widget: z.string().min(1).describe('Widget whose style to copy'),
  to_widget: z.string().min(1).describe('Widget to restyle'),
  to_widget_blueprint_path: z
    .string()
    .optional()
    .describe('Blueprint containing the target, when it differs from the source blueprint.'),
  include: z
    .array(z.enum(['brush', 'text']))
    .optional()
    .default(['brush', 'text'])
    .describe('Which aspects to copy. Never copies slot layout or text content.'),
  dry_run: z.boolean().optional().default(false).describe('Report what would be copied without writing.'),
});

interface BrushInfo {
  draw_as?: string;
  resource?: string;
  margin?: number[];
  brush_tint?: number[];
  tint?: number[];
  image_size_x?: number;
  image_size_y?: number;
  brush_property?: string;
}
interface TextInfo {
  font_object?: string;
  typeface?: string;
  size?: number;
  color?: number[];
}
interface SnapWidget {
  name: string;
  class?: string;
  brush_info?: BrushInfo;
  text_info?: TextInfo;
}

async function snapshotOf(path: string): Promise<SnapWidget[]> {
  const snap = await executeCommand<{ widgets?: SnapWidget[] }>('ui_layout_snapshot', {
    widget_blueprint_path: path,
  });
  return snap.widgets ?? [];
}

export const uiCopyStyleHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { widget_blueprint_path, from_widget, to_widget, include, dry_run } = parsed.data;
  const targetPath = parsed.data.to_widget_blueprint_path ?? widget_blueprint_path;

  const sourceWidgets = await snapshotOf(widget_blueprint_path);
  const source = sourceWidgets.find((w) => w.name === from_widget);
  if (!source) {
    return {
      content: [{ type: 'text', text: `ui_copy_style: source widget "${from_widget}" not found in ${widget_blueprint_path}` }],
      isError: true,
    };
  }

  const targetWidgets =
    targetPath === widget_blueprint_path ? sourceWidgets : await snapshotOf(targetPath);
  const target = targetWidgets.find((w) => w.name === to_widget);
  if (!target) {
    return {
      content: [{ type: 'text', text: `ui_copy_style: target widget "${to_widget}" not found in ${targetPath}` }],
      isError: true,
    };
  }

  const planned: Array<{ aspect: string; values: Record<string, unknown> }> = [];

  if (include.includes('brush') && source.brush_info) {
    const b = source.brush_info;
    const values: Record<string, unknown> = {};
    if (b.draw_as && b.draw_as !== 'Unknown') values.draw_as = b.draw_as;
    if (b.resource) values.resource = b.resource;
    if (Array.isArray(b.margin)) values.margin = b.margin;
    if (Array.isArray(b.brush_tint)) values.tint = b.brush_tint;
    if (typeof b.image_size_x === 'number' && typeof b.image_size_y === 'number') {
      values.image_size = [b.image_size_x, b.image_size_y];
    }
    // Image exposes its brush as `Brush`, Border as `Background`. Use the
    // TARGET's own property name — copying a Border's style onto an Image must
    // write where the Image keeps its brush, not where the Border kept its.
    values.brush_property = target.brush_info?.brush_property ?? b.brush_property ?? 'Brush';
    if (Object.keys(values).length > 1) planned.push({ aspect: 'brush', values });
  }

  if (include.includes('text') && source.text_info?.font_object) {
    const t = source.text_info;
    const values: Record<string, unknown> = {};
    // Font and typeface travel together — a font without its typeface leaves
    // the target on whatever face it had, which is usually the engine Bold.
    values.font_asset = t.font_object;
    values.typeface = t.typeface ?? 'Regular';
    if (typeof t.size === 'number') values.size = t.size;
    if (Array.isArray(t.color)) values.color = t.color;
    planned.push({ aspect: 'text', values });
  }

  if (planned.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              copied: [],
              copied_count: 0,
              note: `"${from_widget}" has no ${include.join('/')} style to copy — it reported no brush and no font. Nothing was written.`,
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
      content: [{ type: 'text', text: JSON.stringify({ dry_run: true, from: from_widget, to: to_widget, would_copy: planned }, null, 2) }],
    };
  }

  const copied: string[] = [];
  const failed: Array<{ aspect: string; error: string }> = [];
  for (const p of planned) {
    try {
      const cmd = p.aspect === 'brush' ? 'ui_set_brush' : 'ui_set_text_style';
      await executeCommand(cmd, {
        widget_blueprint_path: targetPath,
        widget_name: to_widget,
        ...p.values,
      });
      copied.push(p.aspect);
    } catch (e) {
      failed.push({ aspect: p.aspect, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            from: from_widget,
            to: to_widget,
            widget_blueprint_path: targetPath,
            copied,
            copied_count: copied.length,
            applied: planned.filter((p) => copied.includes(p.aspect)),
            failed,
            note: 'Style only — slot layout and text content are left alone. Staged: ui_compile_widget then ui_save_widget to persist.',
          },
          null,
          2,
        ),
      },
    ],
    isError: copied.length === 0 && failed.length > 0,
  };
};
