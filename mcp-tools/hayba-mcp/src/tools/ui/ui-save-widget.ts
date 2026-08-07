import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'saving a Widget Blueprint package to disk after edits',
  not_when: 'compiling without saving (use ui_compile_widget)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the Widget Blueprint to save'),
  compile_first: z.boolean().optional().default(false).describe('Run compile before saving'),
});

export const uiSaveWidgetHandler: ToolHandler = ueTool('ui_save_widget', schema);
