import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['simulates_input'],
  when: 'driving the mouse in a running game — moving, clicking, dragging or scrolling',
  not_when: 'you know what you want to click by name (editor_pie_click_widget is less brittle)',
};

export const schema = z.object({
  action: z
    .enum(['move', 'click', 'double_click', 'press', 'release', 'drag', 'scroll'])
    .default('click')
    .describe('press/release let you hold a button across several calls; drag does the whole gesture.'),
  x: z.number().optional().describe('Target X in viewport pixels. Required for everything except scroll.'),
  y: z.number().optional().describe('Target Y in viewport pixels. Required for everything except scroll.'),
  to_x: z.number().optional().describe('Drag destination X. Required for action:"drag".'),
  to_y: z.number().optional().describe('Drag destination Y. Required for action:"drag".'),
  button: z.enum(['left', 'right', 'middle']).optional().default('left'),
  delta: z.number().optional().describe('Wheel delta for action:"scroll". Positive scrolls up.'),
});

export const pieMouseHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('editor_pie_mouse', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
