import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['simulates_input'],
  when: 'entering text into a focused field in the running game',
  not_when: 'sending a single control key like Enter or Escape (use editor_pie_press_key)',
};

export const schema = z.object({
  text: z
    .string()
    .describe('Characters to send. They go to whatever holds keyboard focus, so click the field first.'),
});

export const pieTypeTextHandler: ToolHandler = ueTool('editor_pie_type_text', schema);
