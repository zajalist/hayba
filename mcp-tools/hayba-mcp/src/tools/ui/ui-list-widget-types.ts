import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
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

export const uiListWidgetTypesHandler: ToolHandler = ueTool('ui_list_widget_types', schema);
