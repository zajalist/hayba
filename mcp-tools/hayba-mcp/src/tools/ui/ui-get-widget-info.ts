import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'getting detailed information about a widget blueprint including properties and GUIDs',
  not_when:
    'searching for widgets by name/class (use ui_search_widgets) or listing available widget types (use ui_list_widget_types)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the Widget Blueprint to inspect'),
  include_properties: z.boolean().optional().default(true).describe('Include widget properties in the response'),
  include_guid: z.boolean().optional().default(true).describe('Include GUIDs in the response'),
});

export const uiGetWidgetInfoHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { widget_blueprint_path, include_properties, include_guid } = parsed.data;
  const data = await executeCommand('ui_query', {
    path: widget_blueprint_path,
    include_properties: include_properties ?? true,
    include_guid: include_guid ?? true,
    include_slot: true,
  } as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
