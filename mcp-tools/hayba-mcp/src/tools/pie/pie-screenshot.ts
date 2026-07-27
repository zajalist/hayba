import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'capturing what the running game looks like right now',
  not_when: 'capturing the editor viewport outside PIE (use editor_capture_viewport)',
};

export const schema = z.object({
  filename: z
    .string()
    .optional()
    .describe('Absolute output path. Defaults to Saved/Screenshots with a timestamp.'),
  check_only: z
    .boolean()
    .optional()
    .describe(
      'Do not capture; just report whether a previously requested file has landed. The engine writes the image a frame or two after the request, so poll with this rather than assuming it is ready.',
    ),
});

export const pieScreenshotHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('editor_pie_screenshot', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
