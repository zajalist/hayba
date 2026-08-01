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

export const schema = z
  .object({
    filename: z
      .string()
      .optional()
      .describe('Absolute output path. Defaults to Saved/Screenshots with a timestamp. check_only:true REQUIRES this (the filename the capture call returned).'),
    path: z
      .string()
      .optional()
      .describe('Alias of filename. Accepted because the object_* tools call the same idea `path`; silently stripping it made check_only polls target a file that was never checked.'),
    check_only: z
      .boolean()
      .optional()
      .describe(
        'Do not capture; just report whether the previously requested file (pass its filename!) has landed. The engine writes the image a frame or two after the request, so poll with this rather than assuming it is ready.',
      ),
    // .strict() so a misspelled key is a loud validation error instead of
    // being stripped pre-wire — the exact failure that made check_only mint a
    // fresh timestamped filename and report captured:false forever.
  })
  .strict();

export const pieScreenshotHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { path, filename, ...rest } = parsed.data;
  const payload: Record<string, unknown> = { ...rest };
  const resolved = filename ?? path;
  if (resolved !== undefined) payload.filename = resolved;
  const data = await executeCommand('editor_pie_screenshot', payload);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
