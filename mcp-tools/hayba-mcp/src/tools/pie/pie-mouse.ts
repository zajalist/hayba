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
  x: z.number().optional().describe('Target X in ABSOLUTE desktop pixels — pass center_x from editor_pie_widget_tree unchanged. Required for everything except scroll, where it is optional and positions the cursor before the wheel.'),
  y: z.number().optional().describe('Target Y in ABSOLUTE desktop pixels — pass center_y from editor_pie_widget_tree unchanged. Required for everything except scroll, where it is optional and positions the cursor before the wheel.'),
  to_x: z.number().optional().describe('Drag destination X. Required for action:"drag".'),
  to_y: z.number().optional().describe('Drag destination Y. Required for action:"drag".'),
  steps: z
    .number()
    .int()
    .optional()
    .describe('Intermediate positions for action:"drag" (default 8, clamped 1..256). Slate quantises the pointer to whole pixels, so steps closer than a pixel apart are dropped rather than sent as no-op moves.'),
  button: z.enum(['left', 'right', 'middle']).optional().default('left'),
  delta: z
    .number()
    .optional()
    .describe('Wheel notches for action:"scroll" (default 1). Positive scrolls up. Delivered as a real Slate FPointerEvent under the cursor, so it reaches ScrollBoxes, list views and combo boxes as well as the game.'),
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
