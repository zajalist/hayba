import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
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

export const uiListWidgetBlueprintsHandler: ToolHandler = ueTool('ui_list_widget_blueprints', schema);
