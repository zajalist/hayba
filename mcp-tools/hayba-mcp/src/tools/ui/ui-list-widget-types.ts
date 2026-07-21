import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'listing available widget classes that can be added to a Widget Blueprint',
  not_when: 'inspecting a specific widget blueprint (use ui_query or ui_get_widget_info)',
};

export const schema = z.object({
  filter: z.string().optional().describe('Optional text filter for widget class names'),
});

export const uiListWidgetTypesHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_list_widget_types', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
