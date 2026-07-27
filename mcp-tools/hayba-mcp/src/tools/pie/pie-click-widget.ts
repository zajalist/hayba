import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
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

export const pieClickWidgetHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('editor_pie_click_widget', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
