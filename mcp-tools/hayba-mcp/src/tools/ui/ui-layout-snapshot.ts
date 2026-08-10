import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: [],
  when: 'you need the resolved on-screen rectangle, font and measured text width of every widget in a blueprint',
  not_when: 'you want the problems rather than the raw data (use ui_validate), or just the tree (use ui_query)',
};

export const schema = z.object({
  widget_blueprint_path: z.string().min(1).describe('Full path of the Widget Blueprint to lay out'),
  screen_width: z
    .number()
    .optional()
    .describe('Resolution to lay out at. Defaults to the blueprint’s design-time size.'),
  screen_height: z
    .number()
    .optional()
    .describe('Resolution to lay out at. Defaults to the blueprint’s design-time size.'),
  widget_names: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe('Return only these exact widget names. Use this for targeted style/geometry reads on large trees.'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Zero-based widget offset for paginating production-sized trees.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Widgets to return per page (maximum 50, matching the UE transport limit).'),
});

export const uiLayoutSnapshotHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  // Runs a real Slate prepass on an instance of the compiled widget class, so
  // `layout_resolved: false` in the response means the blueprint could not be
  // instantiated (usually: it needs compiling first) and every geometry field
  // is absent rather than zero.
  const data = await executeCommand('ui_layout_snapshot', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
