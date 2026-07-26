import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'finding widgets inside a Widget Blueprint by name substring or class, without paying for the whole tree',
  not_when:
    'you want the full hierarchy (use ui_query) or the list of widget classes you could add (use ui_list_widget_types)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the Widget Blueprint to search'),
  widget_name_pattern: z.string().optional().describe('Case-sensitive substring to match widget names against'),
  widget_class: z
    .string()
    .optional()
    .describe(
      'Filter by widget class. Matches the exact class or any ancestor, so "PanelWidget" returns every panel and "TextBlock" returns TextBlocks and RichTextBlocks that derive from it.',
    ),
  include_properties: z.boolean().optional().default(false).describe('Include widget properties in each result'),
  include_guid: z.boolean().optional().default(false).describe('Include the designer variable GUID in each result'),
});

export const uiSearchWidgetsHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { widget_blueprint_path, widget_name_pattern, widget_class, include_properties, include_guid } = parsed.data;

  // The UE command reads `path`, and the filters are named `name_pattern` /
  // `class_filter` there. Forwarding this tool's own field names sent no `path`
  // at all, so every call failed with "ui_query: missing path".
  const data = await executeCommand('ui_query', {
    path: widget_blueprint_path,
    name_pattern: widget_name_pattern,
    class_filter: widget_class,
    include_properties: include_properties ?? false,
    include_guid: include_guid ?? false,
    // Force the flat result shape even when no filter is supplied, so this tool
    // always returns a match list rather than sometimes returning a tree.
    flatten: true,
  } as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
