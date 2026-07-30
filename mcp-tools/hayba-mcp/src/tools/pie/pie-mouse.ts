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
  x: z.number().optional().describe('Target X in ABSOLUTE desktop pixels — pass center_x from editor_pie_widget_tree unchanged. Required for everything except scroll.'),
  y: z.number().optional().describe('Target Y in ABSOLUTE desktop pixels — pass center_y from editor_pie_widget_tree unchanged. Required for everything except scroll.'),
  to_x: z.number().optional().describe('Drag destination X. Required for action:"drag".'),
  to_y: z.number().optional().describe('Drag destination Y. Required for action:"drag".'),
  button: z.enum(['left', 'right', 'middle']).optional().default('left'),
  delta: z.number().optional().describe('Wheel delta for action:"scroll". Positive scrolls up.'),
  coordinate_space: z
    .enum(['absolute', 'viewport'])
    .optional()
    .default('absolute')
    .describe(
      'How x/y are read. "absolute" (default) is desktop pixels, which is what editor_pie_widget_tree reports. "viewport" is relative to the top-left of the game window; only use it if you measured from the window rather than the tree.',
    ),
});

export const pieMouseHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('editor_pie_mouse', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
