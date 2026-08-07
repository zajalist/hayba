import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['simulates_input'],
  when: 'pressing a keyboard or gamepad button in the running game',
  not_when: 'typing a string (use editor_pie_type_text) or analog input (editor_pie_axis)',
};

export const schema = z.object({
  key: z.string().min(1).describe('Key name, e.g. "SpaceBar", "E", "Escape", "Gamepad_FaceButton_Bottom".'),
  event: z
    .enum(['pressed', 'released', 'pressed_and_released'])
    .optional()
    .default('pressed_and_released')
    .describe('pressed_and_released schedules the release on a later tick and returns immediately.'),
  held_ms: z
    .number()
    .optional()
    .describe('How long to hold before the scheduled release. The call does not block for this.'),
});

export const piePressKeyHandler: ToolHandler = ueTool('editor_pie_press_key', schema);
