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
    .describe('Characters to send. With target "pie" they go to the focused widget inside the game viewport, so click the field first.'),
  modifiers: z
    .array(z.enum(['shift', 'ctrl', 'alt', 'cmd']))
    .optional()
    .describe('Modifiers held for this input. Default none: the live keyboard is never read, so a user holding Alt cannot turn an injected key into an editor chord.'),
  target: z
    .enum(['pie', 'focused'])
    .optional()
    .default('pie')
    .describe('"pie" (default) puts keyboard focus inside the PIE game viewport first and refuses if it cannot, so the input never reaches the editor; "focused" sends to whatever holds focus.'),
});

export const pieTypeTextHandler: ToolHandler = ueTool('editor_pie_type_text', schema);
