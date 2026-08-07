import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['starts_pie_session'],
  when: 'starting Play-In-Editor to test runtime behavior',
  not_when: 'the editor is already in PIE — call editor_stop_pie first',
};

export const schema = z.object({
  single_step: z.boolean().optional().default(false),
});

export const editorStartPieHandler: ToolHandler = ueTool('editor_start_pie', schema);
