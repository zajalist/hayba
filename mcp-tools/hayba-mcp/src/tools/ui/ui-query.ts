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
  include_properties: z.boolean().optional().default(false).describe('Include widget properties in the response'),
  include_guid: z.boolean().optional().default(false).describe('Include GUIDs in the response'),
  include_slot: z.boolean().optional().default(true).describe('Include slot layout info in the response'),

  // Passing any of these switches the response from a nested tree to a flat
  // `matches` list. They must be declared here or Zod strips them before
  // dispatch and the handler silently returns the whole tree instead.
  name_pattern: z
    .string()
    .optional()
    .describe('Case-sensitive substring a widget name must contain. Returns a flat `matches` list instead of the tree.'),
  class_filter: z
    .string()
    .optional()
    .describe(
      'Class a widget must be or derive from, e.g. "PanelWidget" for every panel. Returns a flat `matches` list instead of the tree.',
    ),
  flatten: z
    .boolean()
    .optional()
    .describe('Return the flat `matches` list even when no filter is given.'),
});

export const uiQueryHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('ui_query', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
