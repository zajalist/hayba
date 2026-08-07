import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['simulates_input'],
  when: 'filling in a text field to get past it — login boxes, search boxes, name fields',
  not_when: 'you are testing the game\'s own keystroke handling (editor_pie_type_text sends real character events)',
};

/**
 * Set an editable field's text directly, instead of synthesising the keystrokes
 * that would have produced it.
 *
 * editor_pie_type_text drives real character events, which is the honest way to
 * test input handling but a bad way to fill a form: characters go wherever
 * focus happens to be, a modal or hotkey can eat them, and the text is lost if
 * focus moves before the widget commits. Filling a login box to reach the
 * screen behind it needs none of that fidelity — it needs the text to be in the
 * box, and the game to have been told.
 */
export const schema = z.object({
  text: z.string().describe('The value to put in the field. Replaces what is there.'),
  match: z
    .string()
    .optional()
    .describe(
      'Which field, by the text visible on it — the PLACEHOLDER counts, so an empty login box matches "Username". Omit to target whatever currently has keyboard focus.',
    ),
  commit: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Send Enter afterwards so the game\'s OnTextCommitted binding fires (default true). Most games read the value from that binding rather than polling the widget, so without it the box visibly contains the text and the game never receives it. Pass false for a multi-field form where Enter would submit early.',
    ),
});

export const pieSetTextHandler: ToolHandler = ueTool('editor_pie_set_text', schema);
