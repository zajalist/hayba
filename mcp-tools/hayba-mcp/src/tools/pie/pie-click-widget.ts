import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['simulates_input'],
  when: 'clicking a button or control by what it says, rather than guessing pixel coordinates',
  not_when: 'you need an exact position (use editor_pie_mouse with x/y)',
};

export const schema = z.object({
  match: z
    .string()
    .min(1)
    .describe(
      'Text, tag or widget type to find on screen, e.g. "Start Game" or "SButton". Prefers an interactive widget, so matching a label presses the button containing it.',
    ),
});

export const pieClickWidgetHandler: ToolHandler = ueTool('editor_pie_click_widget', schema);
