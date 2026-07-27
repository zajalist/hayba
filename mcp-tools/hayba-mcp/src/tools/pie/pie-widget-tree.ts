import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'seeing what is actually on screen in the running game before interacting with it',
  not_when: 'inspecting a Widget Blueprint asset rather than the live screen (use ui_query)',
};

export const schema = z.object({
  filter: z
    .string()
    .optional()
    .describe('Keep only widgets whose type, tag or visible text contains this. Omit for everything.'),
  max_depth: z.number().int().optional().describe('How deep to walk the Slate tree. Default 40.'),
});

export const pieWidgetTreeHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('editor_pie_widget_tree', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
