import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'compiling a Widget Blueprint to apply pending graph changes and surface compile errors',
  not_when: 'saving without compiling (use ui_save_widget) or editing widget properties',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the Widget Blueprint to compile'),
  save_on_success: z.boolean().optional().default(false).describe('Save the package on successful compile'),
});

export const uiCompileWidgetHandler: ToolHandler = ueTool('ui_compile_widget', schema);
