import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'searching for specific widgets within a Widget Blueprint by name pattern or class type',
  not_when:
    'getting full widget tree info (use ui_get_widget_info) or listing available widget types (use ui_list_widget_types)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the Widget Blueprint to search'),
  widget_name_pattern: z.string().optional().describe('Substring or pattern to match widget names'),
  widget_class: z.string().optional().describe('Filter by widget class name (e.g. "TextBlock", "Button", "Image")'),
  include_properties: z.boolean().optional().default(false).describe('Include widget properties in results'),
});

export const uiSearchWidgetsHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_query', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
