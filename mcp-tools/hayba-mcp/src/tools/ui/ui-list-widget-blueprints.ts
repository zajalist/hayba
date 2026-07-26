import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'discovering the Widget Blueprints that already exist in the project, e.g. to reuse one as a child widget',
  not_when: 'listing native UMG widget classes (use ui_list_widget_types)',
};

export const schema = z.object({
  path: z.string().optional().describe('Restrict to a content path, e.g. "/Game/UI". Searched recursively.'),
  filter: z.string().optional().describe('Case-sensitive substring the asset name must contain'),
});

export const uiListWidgetBlueprintsHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_list_widget_blueprints', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
