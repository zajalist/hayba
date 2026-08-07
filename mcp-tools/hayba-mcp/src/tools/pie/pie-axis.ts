import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['simulates_input'],
  when: 'sending analog input — gamepad sticks, triggers, mouse axes',
  not_when: 'pressing a button (use editor_pie_press_key)',
};

export const schema = z.object({
  key: z
    .string()
    .min(1)
    .describe('Axis key name, e.g. "Gamepad_LeftX", "Gamepad_RightY", "MouseX".'),
  value: z.number().optional().describe('Axis value, normally -1..1. Applies for one frame.'),
});

export const pieAxisHandler: ToolHandler = ueTool('editor_pie_axis', schema);
