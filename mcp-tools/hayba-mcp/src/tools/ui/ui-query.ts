import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'inspecting the widget tree of an existing Widget Blueprint (per-widget class + slot + children)',
  not_when: 'you are mutating the tree (use ui_add_element)',
};

export const schema = z.object({
  path: z
    .string()
    .min(1)
    .describe('Full path of the Widget Blueprint to inspect, e.g. "/Game/Aphrosia/UI/WBP_StartScreen"'),
});

export const uiQueryHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_query', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
